package main

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

type stallHarness struct {
	terminateCalls atomic.Int32
	cpuCalls       atomic.Int32
}

func setupStallTest(t *testing.T, stall, maxSilent time.Duration) *stallHarness {
	t.Helper()
	h := &stallHarness{}
	origStall, origMax, origCPU, origLite := stallTimeoutFn, stallMaxSilentFn, descendantCPUTimeFn, liteMode
	stallTimeoutFn = func() time.Duration { return stall }
	stallMaxSilentFn = func() time.Duration { return maxSilent }
	descendantCPUTimeFn = func(int) (time.Duration, bool) {
		h.cpuCalls.Add(1)
		return 0, false
	}
	liteMode = true
	forceKillDelay.Store(0)
	terminateCommandFn = func(cmd commandRunner) *forceKillTimer {
		h.terminateCalls.Add(1)
		proc := cmd.Process()
		if proc == nil {
			return nil
		}
		_ = proc.Signal(syscall.SIGTERM)
		done := make(chan struct{})
		timer := time.AfterFunc(time.Duration(forceKillDelay.Load())*time.Second, func() {
			_ = proc.Kill()
			close(done)
		})
		return &forceKillTimer{timer: timer, done: done}
	}
	buildCodexArgsFn = func(cfg *Config, targetArg string) []string { return []string{targetArg} }
	codexCommand = "fake-cmd"
	t.Cleanup(func() {
		stallTimeoutFn, stallMaxSilentFn, descendantCPUTimeFn, liteMode = origStall, origMax, origCPU, origLite
		terminateCommandFn = terminateCommand
		resetTestHooks()
	})
	return h
}

func useFake(fake *fakeCmd) {
	newCommandRunner = func(ctx context.Context, name string, args ...string) commandRunner { return fake }
}

// silentFake writes plan and then keeps stdout open and ignores SIGTERM until killed.
func silentFake(plan []fakeStdoutEvent) *fakeCmd {
	return newFakeCmd(fakeCmdConfig{
		StdoutPlan:        plan,
		KeepStdoutOpen:    true,
		BlockWait:         true,
		ReleaseWaitOnKill: true,
	})
}

const (
	stallThreadStarted = `{"type":"thread.started","thread_id":"t1"}` + "\n"
	stallAgentMessage  = `{"type":"item.completed","item":{"type":"agent_message","text":"done"}}` + "\n"
	stallThreadDone    = `{"type":"thread.completed","thread_id":"t1"}` + "\n"
	stallUnknownEvent  = `{"type":"heartbeat.x"}` + "\n"
)

// healthyPlanFake exits shortly after it has written its whole plan.
func healthyPlanFake(plan []fakeStdoutEvent) *fakeCmd {
	var total time.Duration
	for _, ev := range plan {
		total += ev.Delay
	}
	return newFakeCmd(fakeCmdConfig{StdoutPlan: plan, WaitDelay: total + 30*time.Millisecond})
}

func runStallTask(ctx context.Context) TaskResult {
	return runCodexTaskWithContext(ctx, TaskSpec{Task: "stall-task", WorkDir: defaultWorkdir}, nil, nil, false, true, 60)
}

func chunkPlan(rng *rand.Rand, data string, gaps int, maxGap time.Duration) []fakeStdoutEvent {
	var plan []fakeStdoutEvent
	for i := 0; i < len(data); {
		size := 1 + rng.Intn(4)
		if rng.Intn(2) == 0 {
			size = 1
		}
		if i+size > len(data) {
			size = len(data) - i
		}
		plan = append(plan, fakeStdoutEvent{Data: data[i : i+size]})
		i += size
	}
	for g := 0; g < gaps; g++ {
		idx := rng.Intn(len(plan))
		plan[idx].Delay = time.Millisecond + time.Duration(rng.Int63n(int64(maxGap-time.Millisecond)))
	}
	return plan
}

func TestResolveStallTimeout(t *testing.T) {
	cases := []struct {
		raw  string
		want time.Duration
	}{
		{"", 600 * time.Second},
		{"0", 0},
		{"off", 0},
		{"OFF", 0},
		{"false", 0},
		{"-5", 600 * time.Second},
		{"garbage", 600 * time.Second},
		{"1.5", 600 * time.Second},
		{"45", 45 * time.Second},
		{"20000", 20000 * time.Second},
	}
	for _, tc := range cases {
		t.Setenv("CODEAGENT_STALL_TIMEOUT", tc.raw)
		if got := resolveStallTimeout(); got != tc.want {
			t.Errorf("CODEAGENT_STALL_TIMEOUT=%q: got %v, want %v", tc.raw, got, tc.want)
		}
	}
}

func TestResolveStallMaxSilent(t *testing.T) {
	cases := []struct {
		raw  string
		want time.Duration
	}{
		{"", 900 * time.Second},
		{"0", 0},
		{"off", 0},
		{"false", 0},
		{"-1", 900 * time.Second},
		{"x", 900 * time.Second},
		{"1200", 1200 * time.Second},
		{"20000", 20000 * time.Second},
	}
	for _, tc := range cases {
		t.Setenv("CODEAGENT_STALL_MAX_SILENT", tc.raw)
		if got := resolveStallMaxSilent(); got != tc.want {
			t.Errorf("CODEAGENT_STALL_MAX_SILENT=%q: got %v, want %v", tc.raw, got, tc.want)
		}
	}
}

func TestStallTickInterval(t *testing.T) {
	cases := map[time.Duration]time.Duration{
		50 * time.Millisecond:  10 * time.Millisecond,
		200 * time.Millisecond: 20 * time.Millisecond,
		600 * time.Second:      time.Second,
	}
	for in, want := range cases {
		if got := stallTickInterval(in); got != want {
			t.Errorf("stallTickInterval(%v) = %v, want %v", in, got, want)
		}
	}
	if got := stallCPUWindow(600 * time.Second); got != 60*time.Second {
		t.Errorf("stallCPUWindow(600s) = %v", got)
	}
	if got := stallCPUWindow(40 * time.Second); got != 20*time.Second {
		t.Errorf("stallCPUWindow(40s) = %v", got)
	}
}

// P1: gaps all below the stall timeout never give exit 125.
func TestStallP1GapsBelowTimeoutNeverStall(t *testing.T) {
	const S = 200 * time.Millisecond
	rng := rand.New(rand.NewSource(1))
	iterations := 50
	for i := 0; i < iterations; i++ {
		h := setupStallTest(t, S, 0)
		stream := stallThreadStarted + stallUnknownEvent + stallUnknownEvent + stallAgentMessage + stallThreadDone
		plan := chunkPlan(rng, stream, 4, S/2) // 0.75·S flaked under -race with the full suite running
		fake := healthyPlanFake(plan)
		useFake(fake)

		res := runStallTask(context.Background())
		if res.ExitCode == exitCodeStall {
			t.Fatalf("iteration %d: exit 125 with gaps below S: %+v", i, res)
		}
		if res.ExitCode != 0 || res.Message != "done" || res.SessionID != "t1" {
			t.Fatalf("iteration %d: unexpected result %+v", i, res)
		}
		if h.terminateCalls.Load() != 0 {
			t.Fatalf("iteration %d: terminate called %d times", i, h.terminateCalls.Load())
		}
	}
}

// P2: a gap of S+ε with grace off gives exit 125 within S + forceKillDelay + 2.5s.
func TestStallP2SilentBackendStalls(t *testing.T) {
	rng := rand.New(rand.NewSource(2))
	for i, killDelay := range []int32{0, 0, 1} {
		S := time.Duration(100+rng.Intn(150)) * time.Millisecond
		h := setupStallTest(t, S, 0)
		forceKillDelay.Store(killDelay)
		pre := []fakeStdoutEvent{{Data: stallThreadStarted}}
		for n := rng.Intn(3); n > 0; n-- {
			pre = append(pre, fakeStdoutEvent{Delay: time.Duration(rng.Intn(20)) * time.Millisecond, Data: stallUnknownEvent})
		}
		pre = append(pre, fakeStdoutEvent{Delay: 30 * time.Second, Data: stallAgentMessage})
		fake := silentFake(pre)
		useFake(fake)

		start := time.Now()
		res := runStallTask(context.Background())
		elapsed := time.Since(start)

		if res.ExitCode != exitCodeStall {
			t.Fatalf("iteration %d: exit = %d, want 125 (%s)", i, res.ExitCode, res.Error)
		}
		if !strings.HasPrefix(res.Error, "STALLED: fake-cmd produced no output for ") {
			t.Fatalf("iteration %d: error = %q", i, res.Error)
		}
		if res.SessionID != "t1" {
			t.Fatalf("iteration %d: session = %q, want t1", i, res.SessionID)
		}
		limit := S + time.Duration(killDelay)*time.Second + 2500*time.Millisecond
		if elapsed > limit {
			t.Fatalf("iteration %d: took %v, limit %v", i, elapsed, limit)
		}
		if elapsed < S {
			t.Fatalf("iteration %d: stalled after %v, before S=%v", i, elapsed, S)
		}
		if got := h.terminateCalls.Load(); got != 1 {
			t.Fatalf("iteration %d: terminate calls = %d, want 1", i, got)
		}
		if reason := fake.stdout.Reason(); reason != "stall" {
			t.Fatalf("iteration %d: stdout close reason = %q", i, reason)
		}
		if h.cpuCalls.Load() != 0 {
			t.Fatalf("iteration %d: CPU sampled with grace disabled", i)
		}
	}
}

// P3: for one trace and S1 < S2, stall at S2 implies stall at S1.
func TestStallP3Monotonicity(t *testing.T) {
	rng := rand.New(rand.NewSource(3))
	thresholds := []time.Duration{80 * time.Millisecond, 120 * time.Millisecond, 260 * time.Millisecond}
	gapChoices := []time.Duration{15 * time.Millisecond, 180 * time.Millisecond}
	for trace := 0; trace < 20; trace++ {
		var plan []fakeStdoutEvent
		plan = append(plan, fakeStdoutEvent{Data: stallThreadStarted})
		for n := 0; n < 2; n++ {
			plan = append(plan, fakeStdoutEvent{Delay: gapChoices[rng.Intn(len(gapChoices))], Data: stallUnknownEvent})
		}
		plan = append(plan, fakeStdoutEvent{Delay: 10 * time.Millisecond, Data: stallAgentMessage + stallThreadDone})

		stalledAt := make(map[time.Duration]bool)
		for _, S := range thresholds {
			setupStallTest(t, S, 0)
			fake := healthyPlanFake(plan)
			useFake(fake)
			res := runStallTask(context.Background())
			stalledAt[S] = res.ExitCode == exitCodeStall
		}
		for i := 0; i < len(thresholds); i++ {
			for j := i + 1; j < len(thresholds); j++ {
				if stalledAt[thresholds[j]] && !stalledAt[thresholds[i]] {
					t.Fatalf("trace %d: stalled at %v but not at %v", trace, thresholds[j], thresholds[i])
				}
			}
		}
	}
}

// P4: a silent stream with overall timeout T < S gives 124, never 125.
func TestStallP4OverallTimeoutWins(t *testing.T) {
	rng := rand.New(rand.NewSource(4))
	for i := 0; i < 4; i++ {
		T := time.Duration(50+rng.Intn(100)) * time.Millisecond
		S := T + time.Duration(50+rng.Intn(250))*time.Millisecond
		h := setupStallTest(t, S, 0)
		fake := silentFake([]fakeStdoutEvent{{Data: stallThreadStarted}})
		useFake(fake)
		ctx, cancel := context.WithTimeout(context.Background(), T)
		res := runStallTask(ctx)
		cancel()
		if res.ExitCode != 124 {
			t.Fatalf("iteration %d (T=%v S=%v): exit = %d, want 124 (%s)", i, T, S, res.ExitCode, res.Error)
		}
		if res.SessionID != "t1" {
			t.Fatalf("iteration %d: session = %q", i, res.SessionID)
		}
		if h.terminateCalls.Load() != 1 {
			t.Fatalf("iteration %d: terminate calls = %d", i, h.terminateCalls.Load())
		}
	}

	t.Run("deadline during stall teardown", func(t *testing.T) {
		h := setupStallTest(t, 100*time.Millisecond, 0)
		forceKillDelay.Store(1)
		fake := silentFake([]fakeStdoutEvent{{Data: stallThreadStarted}})
		useFake(fake)
		ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
		defer cancel()
		res := runStallTask(ctx)
		if res.ExitCode != 124 {
			t.Fatalf("exit = %d, want 124 when both are due (%s)", res.ExitCode, res.Error)
		}
		if h.terminateCalls.Load() != 1 {
			t.Fatalf("terminate calls = %d, want 1", h.terminateCalls.Load())
		}
	})
}

// P5: stall, ctx deadline, completeSeen and process exit firing together call
// terminateCommandFn at most once and produce one exit code.
func TestStallP5Idempotency(t *testing.T) {
	iterations := 500
	if testing.Short() {
		iterations = 120
	}
	const S = 10 * time.Millisecond
	rng := rand.New(rand.NewSource(5))
	allowed := map[int]bool{0: true, 1: true, 124: true, 125: true}
	for i := 0; i < iterations; i++ {
		h := setupStallTest(t, S, 0)
		jitter := func() time.Duration { return S + time.Duration(rng.Int63n(int64(2*time.Millisecond))) }
		fake := newFakeCmd(fakeCmdConfig{
			StdoutPlan: []fakeStdoutEvent{
				{Data: stallThreadStarted},
				{Delay: jitter(), Data: stallAgentMessage + stallThreadDone},
			},
			WaitDelay: jitter(),
		})
		useFake(fake)
		ctx, cancel := context.WithTimeout(context.Background(), jitter())
		res := runStallTask(ctx)
		cancel()
		if calls := h.terminateCalls.Load(); calls > 1 {
			t.Fatalf("iteration %d: terminateCommandFn called %d times", i, calls)
		}
		if !allowed[res.ExitCode] {
			t.Fatalf("iteration %d: unexpected exit code %d (%s)", i, res.ExitCode, res.Error)
		}
		if res.SessionID != "" && res.SessionID != "t1" {
			t.Fatalf("iteration %d: session = %q", i, res.SessionID)
		}
	}
}

// P9: stall timeout 0 gives the same TaskResult as a build without the watchdog.
func TestStallP9Disabled(t *testing.T) {
	t.Run("success", func(t *testing.T) {
		h := setupStallTest(t, 0, 0)
		fake := healthyPlanFake([]fakeStdoutEvent{
			{Data: stallThreadStarted},
			{Delay: 60 * time.Millisecond, Data: stallAgentMessage + stallThreadDone},
		})
		useFake(fake)
		res := runStallTask(context.Background())
		if res.ExitCode != 0 || res.Message != "done" || res.SessionID != "t1" || res.Error != "" {
			t.Fatalf("unexpected result %+v", res)
		}
		if h.cpuCalls.Load() != 0 || h.terminateCalls.Load() != 0 {
			t.Fatalf("watchdog side effects with S=0: cpu=%d term=%d", h.cpuCalls.Load(), h.terminateCalls.Load())
		}
	})

	t.Run("silent until overall timeout", func(t *testing.T) {
		h := setupStallTest(t, 0, 0)
		fake := silentFake([]fakeStdoutEvent{{Data: stallThreadStarted}})
		useFake(fake)
		ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
		defer cancel()
		res := runStallTask(ctx)
		if res.ExitCode != 124 || !strings.Contains(res.Error, "fake-cmd execution timeout") {
			t.Fatalf("unexpected result %+v", res)
		}
		if h.terminateCalls.Load() != 1 {
			t.Fatalf("terminate calls = %d", h.terminateCalls.Load())
		}
	})

	t.Run("no message", func(t *testing.T) {
		setupStallTest(t, 0, 0)
		fake := newFakeCmd(fakeCmdConfig{StdoutPlan: []fakeStdoutEvent{{Data: stallThreadStarted}}})
		useFake(fake)
		res := runStallTask(context.Background())
		if res.ExitCode != 1 || !strings.Contains(res.Error, "fake-cmd completed without agent_message output") {
			t.Fatalf("unexpected result %+v", res)
		}
	})
}

func TestStallCompletedBackendLingers(t *testing.T) {
	h := setupStallTest(t, 80*time.Millisecond, 0)
	fake := newFakeCmd(fakeCmdConfig{
		StdoutPlan:          []fakeStdoutEvent{{Data: stallThreadStarted + stallAgentMessage + stallThreadDone}},
		KeepStdoutOpen:      true,
		BlockWait:           true,
		ReleaseWaitOnSignal: true,
	})
	useFake(fake)
	res := runStallTask(context.Background())
	if res.ExitCode != 0 || res.Message != "done" {
		t.Fatalf("unexpected result %+v", res)
	}
	if reason := fake.stdout.Reason(); reason != "messageTimer" {
		t.Fatalf("stdout close reason = %q, want messageTimer", reason)
	}
	if h.terminateCalls.Load() != 1 {
		t.Fatalf("terminate calls = %d", h.terminateCalls.Load())
	}
}

func TestStallIdleWarning(t *testing.T) {
	setupStallTest(t, 200*time.Millisecond, 0)
	fake := silentFake([]fakeStdoutEvent{{Data: stallThreadStarted}})
	useFake(fake)
	var res TaskResult
	stderr := captureStderr(t, func() {
		res = runCodexTaskWithContext(context.Background(), TaskSpec{Task: "idle", WorkDir: defaultWorkdir, Progress: true}, nil, nil, false, true, 60)
	})
	if res.ExitCode != exitCodeStall {
		t.Fatalf("exit = %d (%s)", res.ExitCode, res.Error)
	}
	if n := strings.Count(stderr, "[PROGRESS] idle seconds="); n != 1 {
		t.Fatalf("idle warnings = %d, stderr=%q", n, stderr)
	}
}

func TestStallNoCPUSamplingOnHealthyRun(t *testing.T) {
	h := setupStallTest(t, 300*time.Millisecond, 900*time.Millisecond)
	fake := healthyPlanFake([]fakeStdoutEvent{
		{Data: stallThreadStarted},
		{Delay: 100 * time.Millisecond, Data: stallUnknownEvent},
		{Delay: 100 * time.Millisecond, Data: stallAgentMessage + stallThreadDone},
	})
	useFake(fake)
	res := runStallTask(context.Background())
	if res.ExitCode != 0 {
		t.Fatalf("unexpected result %+v", res)
	}
	if h.cpuCalls.Load() != 0 {
		t.Fatalf("CPU sampled %d times on a healthy run", h.cpuCalls.Load())
	}
}

// P8: with CPU always busy, exit 125 happens in [maxSilent, maxSilent + W + teardown];
// with grace disabled, at S.
func TestStallCPUGraceBounds(t *testing.T) {
	rng := rand.New(rand.NewSource(8))
	for i := 0; i < 3; i++ {
		S := time.Duration(100+rng.Intn(100)) * time.Millisecond
		maxSilent := S + time.Duration(150+rng.Intn(250))*time.Millisecond
		W := stallCPUWindow(S)
		setupStallTest(t, S, maxSilent)
		var cpu atomic.Int64
		descendantCPUTimeFn = func(int) (time.Duration, bool) {
			return time.Duration(cpu.Add(int64(2 * time.Second))), true
		}
		fake := silentFake([]fakeStdoutEvent{{Data: stallThreadStarted}})
		useFake(fake)
		start := time.Now()
		res := runStallTask(context.Background())
		elapsed := time.Since(start)
		if res.ExitCode != exitCodeStall {
			t.Fatalf("iteration %d: exit = %d (%s)", i, res.ExitCode, res.Error)
		}
		if elapsed < maxSilent || elapsed > maxSilent+W+2500*time.Millisecond {
			t.Fatalf("iteration %d: stalled after %v, want in [%v, %v]", i, elapsed, maxSilent, maxSilent+W+2500*time.Millisecond)
		}
	}

	t.Run("grace disabled", func(t *testing.T) {
		const S = 150 * time.Millisecond
		h := setupStallTest(t, S, 0)
		var cpu atomic.Int64
		descendantCPUTimeFn = func(int) (time.Duration, bool) {
			h.cpuCalls.Add(1)
			return time.Duration(cpu.Add(int64(2 * time.Second))), true
		}
		fake := silentFake([]fakeStdoutEvent{{Data: stallThreadStarted}})
		useFake(fake)
		start := time.Now()
		res := runStallTask(context.Background())
		elapsed := time.Since(start)
		if res.ExitCode != exitCodeStall || elapsed > S+2500*time.Millisecond {
			t.Fatalf("exit = %d after %v", res.ExitCode, elapsed)
		}
		if h.cpuCalls.Load() != 0 {
			t.Fatalf("CPU sampled with grace disabled")
		}
	})

	t.Run("idle descendants", func(t *testing.T) {
		const S = 150 * time.Millisecond
		setupStallTest(t, S, 2*time.Second)
		descendantCPUTimeFn = func(int) (time.Duration, bool) { return 500 * time.Millisecond, true }
		fake := silentFake([]fakeStdoutEvent{{Data: stallThreadStarted}})
		useFake(fake)
		start := time.Now()
		res := runStallTask(context.Background())
		if res.ExitCode != exitCodeStall || time.Since(start) > S+time.Second {
			t.Fatalf("exit = %d after %v", res.ExitCode, time.Since(start))
		}
	})

	t.Run("sampling fails", func(t *testing.T) {
		const S = 150 * time.Millisecond
		h := setupStallTest(t, S, 2*time.Second)
		fake := silentFake([]fakeStdoutEvent{{Data: stallThreadStarted}})
		useFake(fake)
		start := time.Now()
		res := runStallTask(context.Background())
		if res.ExitCode != exitCodeStall || time.Since(start) > S+time.Second {
			t.Fatalf("exit = %d after %v", res.ExitCode, time.Since(start))
		}
		if h.cpuCalls.Load() != 1 {
			t.Fatalf("cpu sampling attempts = %d, want 1", h.cpuCalls.Load())
		}
	})
}

func TestDescendantCPUTimeInvalidPID(t *testing.T) {
	if _, ok := descendantCPUTime(0); ok {
		t.Fatalf("pid 0 should fail")
	}
}

// P6: a parsed or resumed session ID equals TaskResult.SessionID for exit codes 0, 1, 124, 125, 130.
func TestSessionIDOnFailure(t *testing.T) {
	rng := rand.New(rand.NewSource(6))
	prefix := func() []fakeStdoutEvent {
		plan := []fakeStdoutEvent{}
		for n := rng.Intn(3); n > 0; n-- {
			plan = append(plan, fakeStdoutEvent{Data: stallUnknownEvent})
		}
		plan = append(plan, fakeStdoutEvent{Data: stallThreadStarted})
		for n := rng.Intn(3); n > 0; n-- {
			plan = append(plan, fakeStdoutEvent{Data: stallUnknownEvent})
		}
		return plan
	}
	const S = 150 * time.Millisecond
	endings := []struct {
		name string
		code int
		run  func(t *testing.T, plan []fakeStdoutEvent) TaskResult
	}{
		{"success", 0, func(t *testing.T, plan []fakeStdoutEvent) TaskResult {
			useFake(newFakeCmd(fakeCmdConfig{StdoutPlan: append(plan, fakeStdoutEvent{Data: stallAgentMessage + stallThreadDone})}))
			return runStallTask(context.Background())
		}},
		{"no message", 1, func(t *testing.T, plan []fakeStdoutEvent) TaskResult {
			useFake(newFakeCmd(fakeCmdConfig{StdoutPlan: plan}))
			return runStallTask(context.Background())
		}},
		{"wait error", 1, func(t *testing.T, plan []fakeStdoutEvent) TaskResult {
			useFake(newFakeCmd(fakeCmdConfig{StdoutPlan: plan, WaitErr: errors.New("boom")}))
			return runStallTask(context.Background())
		}},
		{"timeout", 124, func(t *testing.T, plan []fakeStdoutEvent) TaskResult {
			useFake(silentFake(plan))
			ctx, cancel := context.WithTimeout(context.Background(), S/2)
			defer cancel()
			return runStallTask(ctx)
		}},
		{"stall", 125, func(t *testing.T, plan []fakeStdoutEvent) TaskResult {
			useFake(silentFake(plan))
			return runStallTask(context.Background())
		}},
		{"cancel", 130, func(t *testing.T, plan []fakeStdoutEvent) TaskResult {
			useFake(silentFake(plan))
			ctx, cancel := context.WithCancel(context.Background())
			time.AfterFunc(S/3, cancel)
			return runStallTask(ctx)
		}},
	}
	for round := 0; round < 2; round++ {
		for _, ending := range endings {
			setupStallTest(t, S, 0)
			res := ending.run(t, prefix())
			if res.ExitCode != ending.code {
				t.Fatalf("%s: exit = %d, want %d (%s)", ending.name, res.ExitCode, ending.code, res.Error)
			}
			if res.SessionID != "t1" {
				t.Fatalf("%s: session = %q, want t1", ending.name, res.SessionID)
			}
		}
	}

	t.Run("stall during resume", func(t *testing.T) {
		setupStallTest(t, S, 0)
		useFake(silentFake(nil))
		res := runCodexTaskWithContext(context.Background(), TaskSpec{Task: "go on", WorkDir: defaultWorkdir, Mode: "resume", SessionID: "abc"}, nil, nil, false, true, 60)
		if res.ExitCode != exitCodeStall || res.SessionID != "abc" {
			t.Fatalf("unexpected result %+v", res)
		}
	})

	t.Run("no session yet", func(t *testing.T) {
		setupStallTest(t, S, 0)
		useFake(silentFake(nil))
		res := runStallTask(context.Background())
		if res.ExitCode != exitCodeStall || res.SessionID != "" {
			t.Fatalf("unexpected result %+v", res)
		}
	})
}

func TestSessionIDOnFailureSingleTaskStdout(t *testing.T) {
	cases := []struct {
		name    string
		result  TaskResult
		wantOut string
	}{
		{"stall with session", TaskResult{ExitCode: 125, SessionID: "abc", Error: "STALLED: codex produced no output for 600s"}, "\n---\nSESSION_ID: abc\n"},
		{"failure without session", TaskResult{ExitCode: 125, Error: "STALLED: codex produced no output for 600s"}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			defer resetTestHooks()
			cleanupHook = func() {}
			cleanupLogsFn = func() (CleanupStats, error) { return CleanupStats{}, nil }
			selectBackendFn = func(name string) (Backend, error) {
				return testBackend{name: name, command: "echo"}, nil
			}
			result := tc.result
			runTaskFn = func(task TaskSpec, silent bool, timeout int) TaskResult { return result }
			stdinReader = strings.NewReader("")
			isTerminalFn = func() bool { return true }
			oldArgs := os.Args
			os.Args = []string{"codeagent-wrapper", "raw-task"}
			defer func() { os.Args = oldArgs }()

			var code int
			out := captureOutput(t, func() { code = run() })
			if code != tc.result.ExitCode {
				t.Fatalf("exit = %d, want %d", code, tc.result.ExitCode)
			}
			if out != tc.wantOut {
				t.Fatalf("stdout = %q, want %q", out, tc.wantOut)
			}
		})
	}
}

func TestParallelExitCode(t *testing.T) {
	cases := []struct {
		codes []int
		want  int
	}{
		{[]int{0, 0}, 0},
		{[]int{1, 0, 2}, 2},
		{[]int{124, 1}, 124},
		{[]int{1, 124, 2}, 124},
		{[]int{125, 1}, 125},
		{[]int{124, 125, 1}, 125},
		{[]int{0, 130}, 130},
	}
	for _, tc := range cases {
		var results []TaskResult
		for _, c := range tc.codes {
			results = append(results, TaskResult{ExitCode: c})
		}
		if got := parallelExitCode(results); got != tc.want {
			t.Errorf("parallelExitCode(%v) = %d, want %d", tc.codes, got, tc.want)
		}
	}
}

func TestParallelExitCodeSummaryShowsSession(t *testing.T) {
	out := generateFinalOutputWithMode([]TaskResult{{TaskID: "a", ExitCode: 125, SessionID: "abc", Error: "STALLED: codex produced no output for 600s"}}, true)
	if !strings.Contains(out, "Exit code: 125\nSession: abc\n") {
		t.Fatalf("summary missing Session line:\n%s", out)
	}
}

// stallParallelRunner maps the task text (last argument) to a fake command.
func stallParallelRunner(t *testing.T, fakes map[string]func() *fakeCmd) {
	var mu sync.Mutex
	newCommandRunner = func(ctx context.Context, name string, args ...string) commandRunner {
		mu.Lock()
		defer mu.Unlock()
		key := args[len(args)-1]
		mk, ok := fakes[key]
		if !ok {
			t.Errorf("unexpected task %q", key)
			return newFakeCmd(fakeCmdConfig{})
		}
		return mk()
	}
}

func healthyFake(id string) func() *fakeCmd {
	return func() *fakeCmd {
		return healthyPlanFake([]fakeStdoutEvent{
			{Data: fmt.Sprintf(`{"type":"thread.started","thread_id":"sess-%s"}`+"\n", id)},
			{Delay: 20 * time.Millisecond, Data: fmt.Sprintf(`{"type":"item.completed","item":{"type":"agent_message","text":"answer %s"}}`+"\n", id)},
			{Data: fmt.Sprintf(`{"type":"thread.completed","thread_id":"sess-%s"}`+"\n", id)},
		})
	}
}

func setupStallParallel(t *testing.T, S time.Duration) {
	setupStallTest(t, S, 0)
	selectBackendFn = func(name string) (Backend, error) {
		return testBackend{name: "codex", command: "fake-cmd", argsFn: func(cfg *Config, targetArg string) []string { return []string{targetArg} }}, nil
	}
	tmp := t.TempDir()
	t.Setenv("TMPDIR", tmp)
}

// P10: one stalled task leaves independent parallel tasks' results unchanged.
func TestStallParallelIsolation(t *testing.T) {
	const S = 150 * time.Millisecond
	healthyIDs := []string{"h1", "h2", "h3"}

	collect := func(results []TaskResult) map[string]TaskResult {
		out := make(map[string]TaskResult, len(results))
		for _, r := range results {
			out[r.TaskID] = r
		}
		return out
	}

	setupStallParallel(t, S)
	fakes := map[string]func() *fakeCmd{}
	var layer []TaskSpec
	for _, id := range healthyIDs {
		fakes["task-"+id] = healthyFake(id)
		layer = append(layer, TaskSpec{ID: id, Task: "task-" + id})
	}
	stallParallelRunner(t, fakes)
	baseline := collect(executeConcurrentWithContext(context.Background(), [][]TaskSpec{layer}, 60, 2))

	setupStallParallel(t, S)
	fakes["task-stuck"] = func() *fakeCmd {
		return silentFake([]fakeStdoutEvent{{Data: `{"type":"thread.started","thread_id":"sess-stuck"}` + "\n"}})
	}
	stallParallelRunner(t, fakes)
	withStall := append([]TaskSpec{{ID: "stuck", Task: "task-stuck"}}, layer...)
	results := executeConcurrentWithContext(context.Background(), [][]TaskSpec{withStall}, 60, 2)
	got := collect(results)

	if r := got["stuck"]; r.ExitCode != exitCodeStall || r.SessionID != "sess-stuck" {
		t.Fatalf("stuck result = %+v", r)
	}
	for _, id := range healthyIDs {
		b, g := baseline[id], got[id]
		if b.ExitCode != 0 || g.ExitCode != b.ExitCode || g.Message != b.Message || g.SessionID != b.SessionID || g.Error != b.Error {
			t.Fatalf("task %s changed: baseline=%+v with stall=%+v", id, b, g)
		}
	}
	if code := parallelExitCode(results); code != exitCodeStall {
		t.Fatalf("batch exit = %d, want 125", code)
	}
}

func TestParallelExitCodeStallPlusSkippedDependant(t *testing.T) {
	setupStallParallel(t, 150*time.Millisecond)
	stallParallelRunner(t, map[string]func() *fakeCmd{
		"task-a": func() *fakeCmd {
			return silentFake([]fakeStdoutEvent{{Data: `{"type":"thread.started","thread_id":"sess-a"}` + "\n"}})
		},
	})
	layers, err := topologicalSort([]TaskSpec{
		{ID: "a", Task: "task-a"},
		{ID: "b", Task: "task-b", Dependencies: []string{"a"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	results := executeConcurrentWithContext(context.Background(), layers, 60, 0)
	byID := map[string]TaskResult{}
	for _, r := range results {
		byID[r.TaskID] = r
	}
	if byID["a"].ExitCode != exitCodeStall || byID["b"].ExitCode != 1 {
		t.Fatalf("results = %+v", results)
	}
	if code := parallelExitCode(results); code != exitCodeStall {
		t.Fatalf("batch exit = %d, want 125", code)
	}
}

// The next check after a CPU grace is capped at stallMaxSilent.
func TestStallCPUGraceHonoursCeiling(t *testing.T) {
	const S = 400 * time.Millisecond
	const maxSilent = 650 * time.Millisecond
	setupStallTest(t, S, maxSilent)
	var cpu atomic.Int64
	descendantCPUTimeFn = func(int) (time.Duration, bool) {
		return time.Duration(cpu.Add(int64(2 * time.Second))), true
	}
	useFake(silentFake([]fakeStdoutEvent{{Data: stallThreadStarted}}))
	start := time.Now()
	res := runStallTask(context.Background())
	elapsed := time.Since(start)
	if res.ExitCode != exitCodeStall {
		t.Fatalf("exit = %d (%s)", res.ExitCode, res.Error)
	}
	// Checks run at 400ms and 600ms; without the cap the third would be at 800ms.
	if elapsed < maxSilent || elapsed > maxSilent+120*time.Millisecond {
		t.Fatalf("stalled after %v, want about %v", elapsed, maxSilent)
	}
}

func TestStallCPUSumBelowBaselineCountsAsZero(t *testing.T) {
	const S = 150 * time.Millisecond
	setupStallTest(t, S, 2*time.Second)
	var calls atomic.Int32
	descendantCPUTimeFn = func(int) (time.Duration, bool) {
		if calls.Add(1) == 1 {
			return 10 * time.Second, true
		}
		return 2 * time.Second, true
	}
	useFake(silentFake([]fakeStdoutEvent{{Data: stallThreadStarted}}))
	start := time.Now()
	res := runStallTask(context.Background())
	if res.ExitCode != exitCodeStall || time.Since(start) > S+time.Second {
		t.Fatalf("exit = %d after %v", res.ExitCode, time.Since(start))
	}
}

// ctx expiring during a stall teardown whose Wait never returns must not hang.
func TestStallCtxDuringTeardownWaitNeverReturns(t *testing.T) {
	h := setupStallTest(t, 100*time.Millisecond, 0)
	forceKillDelay.Store(1)
	fake := newFakeCmd(fakeCmdConfig{
		StdoutPlan:     []fakeStdoutEvent{{Data: stallThreadStarted}},
		KeepStdoutOpen: true,
		BlockWait:      true,
	})
	fake.process.onKill = nil
	fake.process.onSignal = nil
	useFake(fake)
	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()
	start := time.Now()
	res := runStallTask(ctx)
	elapsed := time.Since(start)
	if res.ExitCode != 124 {
		t.Fatalf("exit = %d, want 124 (%s)", res.ExitCode, res.Error)
	}
	if limit := time.Duration(forceKillDelay.Load())*time.Second + 3*time.Second; elapsed > limit {
		t.Fatalf("returned after %v, limit %v", elapsed, limit)
	}
	if h.terminateCalls.Load() != 1 {
		t.Fatalf("terminate calls = %d, want 1", h.terminateCalls.Load())
	}
}

// The stall clock must not run while a task waits for a worker slot.
func TestStallParallelSlotWaitDoesNotCount(t *testing.T) {
	const S = 200 * time.Millisecond
	setupStallParallel(t, S)
	// Each task writes its first line 0.6·S after its own start and then every
	// 0.5·S until about 2·S, so whichever task waits for the single slot waits
	// longer than S.
	mk := func(id string) func() *fakeCmd {
		return func() *fakeCmd {
			plan := []fakeStdoutEvent{
				{Delay: S * 6 / 10, Data: fmt.Sprintf(`{"type":"thread.started","thread_id":"sess-%s"}`+"\n", id)},
				{Delay: S / 2, Data: stallUnknownEvent},
				{Delay: S / 2, Data: stallUnknownEvent},
				{Delay: S / 2, Data: fmt.Sprintf(`{"type":"item.completed","item":{"type":"agent_message","text":"answer %s"}}`+"\n", id)},
				{Data: fmt.Sprintf(`{"type":"thread.completed","thread_id":"sess-%s"}`+"\n", id)},
			}
			return healthyPlanFake(plan)
		}
	}
	stallParallelRunner(t, map[string]func() *fakeCmd{"task-first": mk("first"), "task-second": mk("second")})
	layer := []TaskSpec{{ID: "first", Task: "task-first"}, {ID: "second", Task: "task-second"}}
	start := time.Now()
	results := executeConcurrentWithContext(context.Background(), [][]TaskSpec{layer}, 60, 1)
	if time.Since(start) < 3*S {
		t.Fatalf("tasks did not run serially (took %v)", time.Since(start))
	}
	for _, r := range results {
		if r.ExitCode != 0 || r.Message != "answer "+r.TaskID {
			t.Fatalf("task %s: %+v", r.TaskID, r)
		}
	}
}
