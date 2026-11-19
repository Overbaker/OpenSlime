package main

import (
	"context"
	"errors"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"
)

// realExitError returns the *exec.ExitError produced by running script under sh.
func realExitError(t *testing.T, script string) error {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("needs sh")
	}
	err := exec.Command("sh", "-c", script).Run()
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		t.Skipf("could not produce an exit error: %v", err)
	}
	return exitErr
}

func runFailingFake(t *testing.T, cfg fakeCmdConfig, spec TaskSpec) (TaskResult, *stallHarness, *fakeCmd) {
	t.Helper()
	h := setupStallTest(t, 0, 0)
	fake := newFakeCmd(cfg)
	useFake(fake)
	spec.WorkDir = defaultWorkdir
	res := runCodexTaskWithContext(context.Background(), spec, nil, nil, false, true, 60)
	return res, h, fake
}

func TestParseAntigravityStreamNoCompleteOnFailure(t *testing.T) {
	inputs := []string{
		`{"event":"result","result":{"conversation_id":"c1","status":"ERROR","response":""}}`,
		`{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","error":"quota exceeded"}}`,
		`{"event":"result","result":{"conversation_id":"c-2","status":"SUCCESS","response":"","num_turns":1,"denied_actions":[{"action":"read_file","display_name":"ReadFile"}]}}`,
	}
	for _, in := range inputs {
		calls := 0
		_, _, failure := parseAntigravityStream(strings.NewReader(in+"\n"), agyStreamHandlers{onComplete: func() { calls++ }})
		if failure == "" || calls != 0 {
			t.Errorf("%s: failure=%q onComplete calls=%d", in, failure, calls)
		}
	}
}

// A lingering agy that reported a failure must not be finished off by the
// post-message timer and must never be reported as success.
func TestAntigravityErrorResultNotCompletedEarly(t *testing.T) {
	exitErr := realExitError(t, "exit 1")
	plan := []fakeStdoutEvent{
		{Data: `{"event":"init","conversation_id":"c1"}` + "\n"},
		{Data: `{"event":"step_update","step_update":{"conversation_id":"c1","step_type":"agent_response","text_delta":"partial "}}` + "\n"},
		{Data: `{"event":"result","result":{"conversation_id":"c1","status":"ERROR","error":"quota exceeded"}}` + "\n"},
	}
	res, h, fake := runFailingFake(t, fakeCmdConfig{
		StdoutPlan:     plan,
		KeepStdoutOpen: true,
		WaitDelay:      1500 * time.Millisecond,
		WaitErr:        exitErr,
	}, TaskSpec{Task: "agy-task", Backend: "antigravity"})
	if res.ExitCode == 0 {
		t.Fatalf("error result reported as success: %+v", res)
	}
	if res.ExitCode != 1 || !strings.HasPrefix(res.Error, "fake-cmd failed: quota exceeded") || res.SessionID != "c1" {
		t.Fatalf("unexpected result %+v", res)
	}
	if h.terminateCalls.Load() != 0 || fake.stdout.Reason() == "messageTimer" {
		t.Fatalf("post-message timer terminated a failed run (terminate=%d reason=%q)", h.terminateCalls.Load(), fake.stdout.Reason())
	}
}

func TestReasonSurvivesNonZeroExit(t *testing.T) {
	t.Run("claude error result", func(t *testing.T) {
		exitErr := realExitError(t, "exit 1")
		res, _, _ := runFailingFake(t, fakeCmdConfig{
			StdoutPlan: []fakeStdoutEvent{{Data: claudeInitLine + "\n" + claudeResultError + "\n"}},
			WaitDelay:  50 * time.Millisecond,
			WaitErr:    exitErr,
		}, TaskSpec{Task: "claude-task"})
		if res.ExitCode != 1 || !strings.HasPrefix(res.Error, "fake-cmd failed: error_during_execution") || res.SessionID != claudeSID {
			t.Fatalf("unexpected result %+v", res)
		}
	})

	t.Run("claude killed without result", func(t *testing.T) {
		exitErr := realExitError(t, "kill -TERM $$")
		res, _, _ := runFailingFake(t, fakeCmdConfig{
			StdoutPlan: []fakeStdoutEvent{{Data: claudeInitLine + "\n" + claudeToolUseLine + "\n" + claudeTextLine + "\n"}},
			WaitDelay:  50 * time.Millisecond,
			WaitErr:    exitErr,
		}, TaskSpec{Task: "claude-task"})
		if res.ExitCode != 1 || !strings.HasPrefix(res.Error, claudeIncompleteReason) || res.SessionID != claudeSID {
			t.Fatalf("unexpected result %+v", res)
		}
	})

	t.Run("exit code above 1 is kept", func(t *testing.T) {
		exitErr := realExitError(t, "exit 3")
		res, _, _ := runFailingFake(t, fakeCmdConfig{
			StdoutPlan: []fakeStdoutEvent{{Data: claudeInitLine + "\n" + claudeResultError + "\n"}},
			WaitDelay:  50 * time.Millisecond,
			WaitErr:    exitErr,
		}, TaskSpec{Task: "claude-task"})
		if res.ExitCode != 3 || !strings.Contains(res.Error, "failed: error_during_execution") {
			t.Fatalf("unexpected result %+v", res)
		}
	})

	t.Run("agy denied actions", func(t *testing.T) {
		exitErr := realExitError(t, "exit 1")
		res, _, _ := runFailingFake(t, fakeCmdConfig{
			StdoutPlan: []fakeStdoutEvent{{Data: `{"event":"init","conversation_id":"c-2"}` + "\n" +
				`{"event":"result","result":{"conversation_id":"c-2","status":"SUCCESS","response":"","num_turns":1,"denied_actions":[{"action":"read_file","display_name":"ReadFile"}]}}` + "\n"}},
			WaitDelay: 50 * time.Millisecond,
			WaitErr:   exitErr,
		}, TaskSpec{Task: "agy-task", Backend: "antigravity"})
		if res.ExitCode != 1 || !strings.HasPrefix(res.Error, "fake-cmd failed: permission denied in headless mode: read_file") || res.SessionID != "c-2" {
			t.Fatalf("unexpected result %+v", res)
		}
	})
}

func TestClaudeIsErrorResultIsNotTheAnswer(t *testing.T) {
	line := `{"type":"result","subtype":"success","is_error":true,"result":"Invalid API key · Please run /login","session_id":"s1"}`
	msg, tid, failure := parseWithFailure(line + "\n")
	if msg != "" || tid != "s1" || failure != "Invalid API key · Please run /login" {
		t.Fatalf("msg=%q tid=%q failure=%q", msg, tid, failure)
	}

	empty := `{"type":"result","subtype":"success","is_error":true,"result":"","session_id":"s1"}`
	if msg, _, failure := parseWithFailure(empty + "\n"); msg != "" || failure != "error" {
		t.Fatalf("empty result: msg=%q failure=%q", msg, failure)
	}

	long := `{"type":"result","subtype":"success","is_error":true,"result":"line one\nline two ` + strings.Repeat("x", 400) + `","session_id":"s1"}`
	_, _, failure = parseWithFailure(long + "\n")
	if strings.Contains(failure, "\n") || len([]rune(failure)) > 200 || !strings.HasPrefix(failure, "line one line two") {
		t.Fatalf("long result reason = %q", failure)
	}

	subtype := `{"type":"result","subtype":"error_max_turns","is_error":false,"result":"partial","session_id":"s1"}`
	if msg, _, failure := parseWithFailure(subtype + "\n"); msg != "" || failure != "error_max_turns" {
		t.Fatalf("subtype result: msg=%q failure=%q", msg, failure)
	}

	setupStallTest(t, 0, 0)
	codexCommand = "claude"
	useFake(healthyPlanFake([]fakeStdoutEvent{{Data: line + "\n"}}))
	res := runStallTask(context.Background())
	if res.ExitCode != 1 || !strings.HasPrefix(res.Error, "claude failed: Invalid API key") || strings.Contains(res.Error, "failed: success") {
		t.Fatalf("unexpected result %+v", res)
	}
}

func TestSumDescendantCPU(t *testing.T) {
	type pt struct {
		created uint64
		cpu     time.Duration
	}
	lookup := func(m map[uint32]pt) processTimesLookup {
		return func(pid uint32) (uint64, time.Duration, bool) {
			v, ok := m[pid]
			return v.created, v.cpu, ok
		}
	}

	t.Run("child created before its parent is pruned with its subtree", func(t *testing.T) {
		children := map[uint32][]uint32{1: {2, 3}, 3: {4}}
		times := map[uint32]pt{
			2: {created: 110, cpu: time.Second},
			3: {created: 50, cpu: 5 * time.Second}, // recycled pid, older than root
			4: {created: 120, cpu: 7 * time.Second},
		}
		if got := sumDescendantCPU(1, 100, children, lookup(times)); got != time.Second {
			t.Fatalf("got %v, want 1s", got)
		}
	})

	t.Run("pid cycle terminates", func(t *testing.T) {
		children := map[uint32][]uint32{1: {2}, 2: {3}, 3: {2, 1}}
		times := map[uint32]pt{2: {created: 110, cpu: time.Second}, 3: {created: 120, cpu: 2 * time.Second}}
		done := make(chan time.Duration, 1)
		go func() { done <- sumDescendantCPU(1, 100, children, lookup(times)) }()
		select {
		case got := <-done:
			if got != 3*time.Second {
				t.Fatalf("got %v, want 3s", got)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("walk did not terminate")
		}
	})

	t.Run("unreadable child counts 0 and passes on the last known creation time", func(t *testing.T) {
		children := map[uint32][]uint32{1: {2}, 2: {3, 4}}
		times := map[uint32]pt{
			// 2 is unreadable (exited or access denied)
			3: {created: 90, cpu: 4 * time.Second}, // older than root's 100: pruned
			4: {created: 130, cpu: 2 * time.Second},
		}
		if got := sumDescendantCPU(1, 100, children, lookup(times)); got != 2*time.Second {
			t.Fatalf("got %v, want 2s", got)
		}
	})

	t.Run("root excluded", func(t *testing.T) {
		times := map[uint32]pt{1: {created: 100, cpu: time.Hour}}
		if got := sumDescendantCPU(1, 100, map[uint32][]uint32{}, lookup(times)); got != 0 {
			t.Fatalf("got %v, want 0", got)
		}
	})
}
