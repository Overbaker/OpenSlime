package main

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// A failure reported before the backend went silent wins over STALLED.
func TestStallKeepsParsedFailure(t *testing.T) {
	cases := map[string]struct {
		result string
		want   string
	}{
		"denied actions": {agyDeniedResult, "fake-cmd failed: permission denied in headless mode: read_file"},
		"error status":   {agyQuotaResult, "fake-cmd failed: quota exceeded"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			h := setupStallTest(t, 150*time.Millisecond, 0)
			useFake(silentFake([]fakeStdoutEvent{{Data: `{"event":"init","conversation_id":"c-3"}` + "\n" + tc.result + "\n"}}))
			res := runCodexTaskWithContext(context.Background(), TaskSpec{Task: "agy-task", WorkDir: defaultWorkdir, Backend: "antigravity"}, nil, nil, false, true, 60)
			if res.ExitCode != 1 || !strings.HasPrefix(res.Error, tc.want) || res.SessionID != "c-3" {
				t.Fatalf("unexpected result %+v", res)
			}
			if h.terminateCalls.Load() != 1 {
				t.Fatalf("terminate calls = %d", h.terminateCalls.Load())
			}
		})
	}

	t.Run("claude incomplete stays a stall", func(t *testing.T) {
		setupStallTest(t, 150*time.Millisecond, 0)
		codexCommand = "claude"
		useFake(silentFake([]fakeStdoutEvent{{Data: claudeInitLine + "\n" + claudeToolUseLine + "\n"}}))
		res := runStallTask(context.Background())
		if res.ExitCode != exitCodeStall || !strings.HasPrefix(res.Error, "STALLED: claude") || res.SessionID != claudeSID {
			t.Fatalf("unexpected result %+v", res)
		}
	})
}

// Overall timeout while cmd.Wait never returns (a grandchild holds the pipes).
func TestCtxTimeoutWaitNeverReturns(t *testing.T) {
	h := setupStallTest(t, 0, 0)
	forceKillDelay.Store(1)
	fake := newFakeCmd(fakeCmdConfig{
		StdoutPlan:     []fakeStdoutEvent{{Data: stallThreadStarted}},
		KeepStdoutOpen: true,
		BlockWait:      true,
	})
	fake.process.onKill = nil
	fake.process.onSignal = nil
	useFake(fake)
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	start := time.Now()
	res := runStallTask(ctx)
	elapsed := time.Since(start)
	if res.ExitCode != 124 || res.SessionID != "t1" {
		t.Fatalf("unexpected result %+v", res)
	}
	if limit := time.Duration(forceKillDelay.Load())*time.Second + 3*time.Second; elapsed > limit {
		t.Fatalf("returned after %v, limit %v", elapsed, limit)
	}
	if h.terminateCalls.Load() != 1 {
		t.Fatalf("terminate calls = %d, want 1", h.terminateCalls.Load())
	}
	if reason := fake.stdout.Reason(); reason != stdoutCloseReasonCtx {
		t.Fatalf("stdout close reason = %q", reason)
	}
}

func TestActivityReaderIdleIsMonotonicOffset(t *testing.T) {
	a := newActivityReader(strings.NewReader("x"))
	now := time.Now()
	if idle := a.idleAt(now.Add(5 * time.Second)); idle < 5*time.Second || idle > 6*time.Second {
		t.Fatalf("idle = %v, want about 5s", idle)
	}
	buf := make([]byte, 1)
	time.Sleep(20 * time.Millisecond)
	if _, err := a.Read(buf); err != nil {
		t.Fatal(err)
	}
	if idle := a.idleAt(time.Now()); idle < 0 || idle > 10*time.Millisecond {
		t.Fatalf("idle after read = %v", idle)
	}
}

func TestParallelSkippedAndCancelledKeepSessionID(t *testing.T) {
	t.Run("skipped", func(t *testing.T) {
		setupStallParallel(t, 0)
		stallParallelRunner(t, map[string]func() *fakeCmd{
			"task-a": func() *fakeCmd { return newFakeCmd(fakeCmdConfig{StartErr: errors.New("boom")}) },
		})
		layers, err := topologicalSort([]TaskSpec{
			{ID: "a", Task: "task-a"},
			{ID: "b", Task: "task-b", Mode: "resume", SessionID: "abc", Dependencies: []string{"a"}},
		})
		if err != nil {
			t.Fatal(err)
		}
		results := executeConcurrentWithContext(context.Background(), layers, 60, 0)
		for _, r := range results {
			if r.TaskID == "b" && (r.ExitCode != 1 || !strings.Contains(r.Error, "skipped") || r.SessionID != "abc") {
				t.Fatalf("skipped result = %+v", r)
			}
		}
	})

	t.Run("cancelled", func(t *testing.T) {
		setupStallParallel(t, 0)
		stallParallelRunner(t, map[string]func() *fakeCmd{})
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		results := executeConcurrentWithContext(ctx, [][]TaskSpec{{{ID: "r", Task: "task-r", Mode: "resume", SessionID: "abc"}}}, 60, 1)
		if len(results) != 1 || results[0].ExitCode != 130 || results[0].SessionID != "abc" {
			t.Fatalf("cancelled results = %+v", results)
		}
	})
}

func TestClaudeErrorResultClearsEarlierAnswer(t *testing.T) {
	ok := `{"type":"result","subtype":"success","is_error":false,"result":"A","session_id":"s1"}`
	bad := `{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"s1"}`
	msg, _, failure := parseWithFailure(ok + "\n" + bad + "\n")
	if msg != "" || failure != "error_during_execution" {
		t.Fatalf("msg=%q failure=%q", msg, failure)
	}
}
