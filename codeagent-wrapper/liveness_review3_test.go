package main

import (
	"context"
	"strings"
	"testing"
	"time"
)

const (
	agyDeniedResult = `{"event":"result","result":{"conversation_id":"c-3","status":"SUCCESS","response":"","num_turns":1,"denied_actions":[{"action":"read_file","display_name":"ReadFile"}]}}`
	agyQuotaResult  = `{"event":"result","result":{"conversation_id":"c-3","status":"ERROR","error":"quota exceeded"}}`
)

func agyDelta(text string) string {
	return `{"event":"step_update","step_update":{"conversation_id":"c-3","step_type":"agent_response","text_delta":"` + text + `"}}`
}

func TestParseAntigravityStreamFailureHasNoMessage(t *testing.T) {
	cases := map[string]string{
		"denied after deltas":       agyDelta("Let me read that file.") + "\n" + agyDeniedResult + "\n",
		"error after deltas":        agyDelta("partial ") + "\n" + agyQuotaResult + "\n",
		"error with plain lines":    "stray line\n" + agyQuotaResult + "\n",
		"error with response field": `{"event":"result","result":{"conversation_id":"c-3","status":"ERROR","response":"half an answer","error":"boom"}}` + "\n",
	}
	for name, in := range cases {
		msg, id, failure := parseAntigravityStream(strings.NewReader(in), agyStreamHandlers{})
		if msg != "" || failure == "" || id != "c-3" {
			t.Errorf("%s: msg=%q failure=%q id=%q", name, msg, failure, id)
		}
	}

	// Without a result event the delta fallback still applies.
	if msg, _, failure := parseAntigravityStream(strings.NewReader(agyDelta("partial review")+"\n"), agyStreamHandlers{}); msg != "partial review" || failure != "" {
		t.Fatalf("fallback: msg=%q failure=%q", msg, failure)
	}
}

func TestAntigravityDeniedResultExitZeroIsFailure(t *testing.T) {
	res, _, _ := runFailingFake(t, fakeCmdConfig{
		StdoutPlan: []fakeStdoutEvent{{Data: `{"event":"init","conversation_id":"c-3"}` + "\n" + agyDelta("Let me read that file.") + "\n" + agyDeniedResult + "\n"}},
		WaitDelay:  50 * time.Millisecond,
	}, TaskSpec{Task: "agy-task", Backend: "antigravity"})
	if res.ExitCode != 1 || !strings.HasPrefix(res.Error, "fake-cmd failed: permission denied in headless mode: read_file") || res.SessionID != "c-3" || res.Message != "" {
		t.Fatalf("unexpected result %+v", res)
	}
}

// Failure after stdout ends: EOF, then a non-zero exit after the post-message delay.
func TestAntigravityFailureAfterStdoutEnds(t *testing.T) {
	exitErr := realExitError(t, "exit 1")
	res, h, _ := runFailingFake(t, fakeCmdConfig{
		StdoutPlan: []fakeStdoutEvent{{Data: `{"event":"init","conversation_id":"c-3"}` + "\n" + agyDelta("partial ") + "\n" + agyQuotaResult + "\n"}},
		WaitDelay:  1500 * time.Millisecond,
		WaitErr:    exitErr,
	}, TaskSpec{Task: "agy-task", Backend: "antigravity"})
	if res.ExitCode == 0 || !strings.HasPrefix(res.Error, "fake-cmd failed: quota exceeded") || res.Message != "" || res.SessionID != "c-3" {
		t.Fatalf("unexpected result %+v", res)
	}
	if h.terminateCalls.Load() > 1 {
		t.Fatalf("terminate calls = %d", h.terminateCalls.Load())
	}
}

// Each stdout read starts a new silent period, so heartbeats spaced beyond S/2
// give one idle line per period, never two within one period.
func TestStallIdleWarningOncePerSilentPeriod(t *testing.T) {
	const S = 200 * time.Millisecond
	setupStallTest(t, S, 0)
	useFake(healthyPlanFake([]fakeStdoutEvent{
		{Data: stallThreadStarted},
		{Delay: 150 * time.Millisecond, Data: stallUnknownEvent},
		{Delay: 150 * time.Millisecond, Data: stallUnknownEvent},
		{Delay: 150 * time.Millisecond, Data: stallAgentMessage + stallThreadDone},
	}))
	var res TaskResult
	stderr := captureStderr(t, func() {
		res = runCodexTaskWithContext(context.Background(), TaskSpec{Task: "idle", WorkDir: defaultWorkdir, Progress: true}, nil, nil, false, true, 60)
	})
	if res.ExitCode != 0 {
		t.Fatalf("unexpected result %+v", res)
	}
	if n := strings.Count(stderr, "[PROGRESS] idle seconds="); n != 3 {
		t.Fatalf("idle lines = %d, want 3 (one per silent period); stderr=%q", n, stderr)
	}
}

// agy reports an error, closes stdout and never exits by itself: the
// post-message timer must end the run with the real reason, not a stall.
func TestAntigravityFailureStdoutClosedProcessLingers(t *testing.T) {
	cases := []struct {
		name    string
		waitErr func(t *testing.T) error
	}{
		{"killed, no exit error", func(*testing.T) error { return nil }},
		{"killed by signal", func(t *testing.T) error { return realExitError(t, "kill -TERM $$") }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			waitErr := tc.waitErr(t)
			h := setupStallTest(t, 10*time.Second, 0)
			fake := newFakeCmd(fakeCmdConfig{
				StdoutPlan:        []fakeStdoutEvent{{Data: `{"event":"init","conversation_id":"c-3"}` + "\n" + agyDelta("partial ") + "\n" + agyQuotaResult + "\n"}},
				BlockWait:         true,
				ReleaseWaitOnKill: true,
				WaitErr:           waitErr,
			})
			useFake(fake)
			start := time.Now()
			res := runCodexTaskWithContext(context.Background(), TaskSpec{Task: "agy-task", WorkDir: defaultWorkdir, Backend: "antigravity"}, nil, nil, false, true, 60)
			elapsed := time.Since(start)
			limit := resolvePostMessageDelay() + time.Duration(forceKillDelay.Load())*time.Second + 3*time.Second
			if elapsed > limit {
				t.Fatalf("took %v, limit %v", elapsed, limit)
			}
			if res.ExitCode != 1 || !strings.HasPrefix(res.Error, "fake-cmd failed: quota exceeded") || res.SessionID != "c-3" || res.Message != "" {
				t.Fatalf("unexpected result %+v", res)
			}
			if h.terminateCalls.Load() != 1 {
				t.Fatalf("terminate calls = %d, want 1", h.terminateCalls.Load())
			}
		})
	}
}
