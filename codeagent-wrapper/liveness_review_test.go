package main

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestSessionIDResumeSuccessWithoutSessionEvent(t *testing.T) {
	setupStallTest(t, 300*time.Millisecond, 0)
	useFake(healthyPlanFake([]fakeStdoutEvent{{Data: stallAgentMessage}}))
	res := runCodexTaskWithContext(context.Background(), TaskSpec{Task: "go on", WorkDir: defaultWorkdir, Mode: "resume", SessionID: "abc"}, nil, nil, false, true, 60)
	if res.ExitCode != 0 || res.Message != "done" || res.SessionID != "abc" {
		t.Fatalf("unexpected result %+v", res)
	}
}

func TestSessionIDResumeParsedIDWins(t *testing.T) {
	setupStallTest(t, 300*time.Millisecond, 0)
	useFake(healthyPlanFake([]fakeStdoutEvent{{Data: stallThreadStarted + stallAgentMessage + stallThreadDone}}))
	res := runCodexTaskWithContext(context.Background(), TaskSpec{Task: "go on", WorkDir: defaultWorkdir, Mode: "resume", SessionID: "abc"}, nil, nil, false, true, 60)
	if res.ExitCode != 0 || res.SessionID != "t1" {
		t.Fatalf("unexpected result %+v", res)
	}
}

func TestSessionIDResumeEarlyFailure(t *testing.T) {
	setupStallTest(t, 300*time.Millisecond, 0)
	useFake(newFakeCmd(fakeCmdConfig{StartErr: errors.New("boom")}))
	res := runCodexTaskWithContext(context.Background(), TaskSpec{Task: "go on", WorkDir: defaultWorkdir, Mode: "resume", SessionID: "abc"}, nil, nil, false, true, 60)
	if res.ExitCode != 1 || !strings.Contains(res.Error, "failed to start fake-cmd") || res.SessionID != "abc" {
		t.Fatalf("unexpected result %+v", res)
	}
}

func TestParseAntigravityStreamOnComplete(t *testing.T) {
	calls := 0
	msg, _, _ := parseAntigravityStream(strings.NewReader(agyStreamSample), agyStreamHandlers{
		onComplete: func() { calls++ },
	})
	if calls != 1 || msg != "Found 3 bugs." {
		t.Fatalf("onComplete calls = %d, msg = %q", calls, msg)
	}
}

func TestStallAntigravityLingersAfterResult(t *testing.T) {
	const S = 100 * time.Millisecond
	h := setupStallTest(t, S, 0)
	lines := strings.Split(strings.TrimSpace(agyStreamSample), "\n")
	plan := []fakeStdoutEvent{
		{Data: lines[0] + "\n"},
		{Delay: 10 * time.Millisecond, Data: lines[len(lines)-1] + "\n"},
	}
	fake := newFakeCmd(fakeCmdConfig{
		StdoutPlan:          plan,
		KeepStdoutOpen:      true,
		BlockWait:           true,
		ReleaseWaitOnSignal: true,
	})
	useFake(fake)
	res := runCodexTaskWithContext(context.Background(), TaskSpec{Task: "agy-task", WorkDir: defaultWorkdir, Backend: "antigravity"}, nil, nil, false, true, 60)
	if res.ExitCode != 0 || res.Message != "Found 3 bugs." || res.SessionID != "602e61bb-d2a0" {
		t.Fatalf("unexpected result %+v", res)
	}
	if reason := fake.stdout.Reason(); reason != "messageTimer" {
		t.Fatalf("stdout close reason = %q, want messageTimer", reason)
	}
	if h.terminateCalls.Load() != 1 {
		t.Fatalf("terminate calls = %d", h.terminateCalls.Load())
	}
}

func parseWithFailure(input string) (message, threadID, failure string) {
	message, threadID = parseJSONStreamWithFailure(strings.NewReader(input), nil, nil, nil, nil, nil, nil, nil,
		func(reason string) { failure = reason })
	return
}

func TestClaudeClassificationExcludesCodexAndOpencode(t *testing.T) {
	cases := map[string]struct {
		input string
		want  string
	}{
		"codex with subtype": {
			`{"type":"item.completed","item":{"type":"agent_message","text":"ok"},"subtype":"x"}`, "ok",
		},
		"opencode with subtype": {
			`{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"hello"},"subtype":"x"}`, "hello",
		},
		"opencode user type": {
			`{"type":"user","sessionID":"ses_1","part":{"type":"text","text":"hello"},"message":{"x":1}}`, "",
		},
	}
	for name, tc := range cases {
		msg, _, failure := parseWithFailure(tc.input + "\n")
		if msg != tc.want || failure != "" {
			t.Errorf("%s: msg=%q failure=%q", name, msg, failure)
		}
	}
}

func TestClaudeClassificationNeedsMessageOrSession(t *testing.T) {
	input := strings.Join([]string{
		`{"type":"turn.started"}`,
		`{"type":"assistant","text":"hi"}`,
		`{"type":"user","text":"yo"}`,
		`{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}`,
	}, "\n")
	msg, _, failure := parseWithFailure(input)
	if msg != "ok" || failure != "" {
		t.Fatalf("msg=%q failure=%q", msg, failure)
	}

	msg, _, failure = parseWithFailure(`{"type":"assistant","text":"hi"}` + "\n")
	if msg != "" || failure != "" {
		t.Fatalf("bare assistant: msg=%q failure=%q", msg, failure)
	}

	_, _, failure = parseWithFailure(`{"type":"assistant","session_id":"s1"}` + "\n")
	if failure != claudeIncompleteReason {
		t.Fatalf("assistant with session id: failure=%q", failure)
	}
}

func TestClaudeErrorResultWithoutSubtypeOrSession(t *testing.T) {
	msg, _, failure := parseWithFailure(`{"type":"result","is_error":true}` + "\n")
	if msg != "" || failure != "error" {
		t.Fatalf("msg=%q failure=%q", msg, failure)
	}

	setupStallTest(t, 0, 0)
	codexCommand = "claude"
	useFake(healthyPlanFake([]fakeStdoutEvent{{Data: `{"type":"result","is_error":true}` + "\n"}}))
	res := runStallTask(context.Background())
	if res.ExitCode != 1 || !strings.HasPrefix(res.Error, "claude failed: error") {
		t.Fatalf("unexpected result %+v", res)
	}
}

func TestClaudeIncompleteOnlyWhenMessageEmpty(t *testing.T) {
	input := claudeInitLine + "\n" + claudeTextLine + "\n" +
		`{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}` + "\n"
	msg, _, failure := parseWithFailure(input)
	if msg != "ok" || failure != "" {
		t.Fatalf("msg=%q failure=%q", msg, failure)
	}
}

func TestResolveStallRejectsHugeValues(t *testing.T) {
	t.Setenv("CODEAGENT_STALL_TIMEOUT", "9999999999")
	if got := resolveStallTimeout(); got != defaultStallTimeout {
		t.Fatalf("timeout = %v, want default", got)
	}
	t.Setenv("CODEAGENT_STALL_MAX_SILENT", "9999999999")
	if got := resolveStallMaxSilent(); got != defaultStallMaxSilent {
		t.Fatalf("max silent = %v, want default", got)
	}
	t.Setenv("CODEAGENT_STALL_TIMEOUT", "31536000")
	if got := resolveStallTimeout(); got != 31536000*time.Second {
		t.Fatalf("one year = %v", got)
	}
}
