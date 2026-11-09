package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
	"testing"
	"time"
)

func TestPiBackendRegistrationAndArgs(t *testing.T) {
	backend, err := selectBackend(" pi ")
	if err != nil || backend.Name() != "pi" {
		t.Fatalf("Pi is not registered: backend=%v, err=%v", backend, err)
	}

	t.Setenv("CODEAGENT_PI_COMMAND", "/tools/pi")
	got := buildPiArgs(&Config{
		Backend: "pi", Mode: "resume", SessionID: "session-id",
		WorkDir: "/work", PiModel: " hkchat-test/model ", WithMCP: true,
	}, "prompt must not be an argument")
	wantCommand := "/tools/pi"
	if b := (PiBackend{}); b.Command() != wantCommand {
		t.Fatalf("Command() = %q, want %q", b.Command(), wantCommand)
	}
	want := []string{"--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates", "--session", "session-id", "--model", "hkchat-test/model"}
	if strings.Join(got, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("buildPiArgs() = %#v, want %#v", got, want)
	}
	for _, arg := range got {
		if strings.Contains(arg, "prompt must") || arg == "--no-mcp" {
			t.Fatalf("unexpected RPC argv entry %q", arg)
		}
	}
}

func TestPiConfigFlagAndEnvironment(t *testing.T) {
	oldArgs := os.Args
	t.Cleanup(func() { os.Args = oldArgs })

	t.Setenv("PI_MODEL", "provider/from-env")
	os.Args = []string{"codeagent-wrapper", "--backend", "pi", "--pi-model", " provider/from-cli ", "work"}
	cfg, err := parseArgs()
	if err != nil || cfg.PiModel != "provider/from-cli" || cfg.Backend != "pi" {
		t.Fatalf("CLI Pi config = %+v, err=%v", cfg, err)
	}

	os.Args = []string{"codeagent-wrapper", "--backend=pi", "work"}
	cfg, err = parseArgs()
	if err != nil || cfg.PiModel != "provider/from-env" {
		t.Fatalf("environment Pi config = %+v, err=%v", cfg, err)
	}

	for _, args := range [][]string{
		{"codeagent-wrapper", "--backend", "pi", "--pi-model", "", "work"},
		{"codeagent-wrapper", "--backend", "pi", "--pi-model= ", "work"},
		{"codeagent-wrapper", "--backend", "pi", "--pi-model", "--with-mcp", "work"},
		{"codeagent-wrapper", "--backend", "pi", "--pi-model=-h", "work"},
	} {
		os.Args = args
		if _, err := parseArgs(); err == nil {
			t.Fatalf("expected invalid model error for %#v", args)
		}
	}
}

func TestBuildPiRPCInputPreservesPrompt(t *testing.T) {
	prompt := "@README.md\nfirst line\r\nsecond \"quoted\" line\n$HOME `literal`"
	input, err := buildPiRPCInput(prompt)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSuffix(input, "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("got %d JSONL lines, want 2: %q", len(lines), input)
	}
	var state, command map[string]any
	if json.Unmarshal([]byte(lines[0]), &state) != nil || state["type"] != "get_state" {
		t.Fatalf("invalid first command: %s", lines[0])
	}
	if err := json.Unmarshal([]byte(lines[1]), &command); err != nil {
		t.Fatal(err)
	}
	if command["type"] != "prompt" || command["message"] != prompt {
		t.Fatalf("prompt changed in transport: %#v", command)
	}
}

func TestParsePiRPCStreamSuccess(t *testing.T) {
	input := strings.Join([]string{
		`{"type":"response","id":"state","command":"get_state","success":true,"data":{"sessionId":"pi-session","isStreaming":false}}`,
		`{"type":"response","id":"prompt","command":"prompt","success":true}`,
		`{"type":"agent_start"}`,
		`{"type":"message_update","assistantEvent":{"type":"text_delta","delta":"first "}}`,
		`{"type":"message_update","assistantEvent":{"type":"text_delta","delta":"second"}}`,
		`{"type":"tool_execution_start","toolName":"read","toolCallId":"call-1"}`,
		`{"type":"tool_execution_end","toolName":"read","isError":false,"result":{"content":[{"type":"text","text":"file"}]}}`,
		`{"type":"message_end","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"first second"}]}}`,
		`{"type":"agent_settled"}`,
		``,
	}, "\n")
	completed := 0
	var content strings.Builder
	result := parsePiRPCStream(strings.NewReader(input), func(s string) { t.Log(s) }, func(s string) { t.Log(s) }, piStreamCallbacks{
		onComplete: func() { completed++ },
		onContent:  func(text, _ string) { content.WriteString(text) },
	})
	if result.err != nil || result.message != "first second" || result.threadID != "pi-session" {
		t.Fatalf("unexpected result: %+v", result)
	}
	if completed != 1 || content.String() != "first second" {
		t.Fatalf("callbacks: completed=%d, content=%q", completed, content.String())
	}
}

func TestParsePiRPCStreamIgnoresClosedPipeAfterSettlement(t *testing.T) {
	stream := `{"type":"response","command":"get_state","success":true,"data":{"sessionId":"closed-after-settlement"}}` + "\n" +
		`{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}` + "\n" +
		`{"type":"agent_settled"}` + "\n"
	reader := io.MultiReader(strings.NewReader(stream), errReader{err: errors.New("transport closed after settlement")})
	var completions int
	result := parsePiRPCStream(reader, nil, nil, piStreamCallbacks{onComplete: func() { completions++ }})
	if result.err != nil || result.message != "done" || result.threadID != "closed-after-settlement" {
		t.Fatalf("unexpected settled result: %+v", result)
	}
	if completions != 1 {
		t.Fatalf("completions = %d, want 1", completions)
	}
}

func TestParsePiRPCStreamUsesFinalMessageWithoutDelta(t *testing.T) {
	input := `{"type":"response","command":"get_state","success":true,"data":{"sessionId":"s"}}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"final answer"}]}}
{"type":"agent_settled"}`
	var content string
	result := parsePiRPCStream(strings.NewReader(input), nil, nil, piStreamCallbacks{
		onContent: func(text, _ string) { content += text },
	})
	if result.err != nil || result.message != "final answer" || content != "final answer" {
		t.Fatalf("unexpected result: %+v content=%q", result, content)
	}
}

func TestParsePiRPCStreamRequiresSettlement(t *testing.T) {
	input := "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"partial\"}]}}\n"
	result := parsePiRPCStream(strings.NewReader(input), nil, nil, piStreamCallbacks{})
	if result.err == nil || !strings.Contains(result.err.Error(), "before agent_settled") {
		t.Fatalf("premature EOF should fail: %+v", result)
	}
	if result.message != "partial" {
		t.Fatalf("partial message should be preserved for diagnostics: %+v", result)
	}
}

func TestParsePiRPCStreamCommandErrorIsFailure(t *testing.T) {
	result := parsePiRPCStream(strings.NewReader(`{"type":"response","command":"prompt","success":false,"error":"agent busy"}`), nil, nil, piStreamCallbacks{})
	if result.err == nil || !strings.Contains(result.err.Error(), "agent busy") {
		t.Fatalf("expected rejected prompt failure, got %+v", result)
	}
}

func TestParsePiRPCStreamProviderFailureIsFailure(t *testing.T) {
	input := `{"type":"response","command":"get_state","success":true,"data":{"sessionId":"s"}}
{"type":"auto_retry_end","success":false,"error":"rate limit retries exhausted"}
{"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"rate limited","content":[]}}
{"type":"agent_settled"}`
	result := parsePiRPCStream(strings.NewReader(input), nil, nil, piStreamCallbacks{})
	if result.err == nil || !strings.Contains(result.err.Error(), "rate limit") {
		t.Fatalf("expected provider failure, got %+v", result)
	}
	if result.threadID != "s" {
		t.Fatalf("session should survive failure: %+v", result)
	}
}

func TestParsePiRPCStreamPreservesAssistantErrorMessage(t *testing.T) {
	input := `{"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"provider rejected request","content":[]}}
{"type":"agent_settled"}`
	result := parsePiRPCStream(strings.NewReader(input), nil, nil, piStreamCallbacks{})
	if result.err == nil || !strings.Contains(result.err.Error(), "provider rejected request") {
		t.Fatalf("expected assistant error details, got %+v", result)
	}
}

func TestRunPiRPCSuccessAndStdinLifecycle(t *testing.T) {
	defer resetTestHooks()
	fake := newFakeCmd(fakeCmdConfig{StdoutPlan: []fakeStdoutEvent{
		{Data: `{"type":"response","command":"get_state","success":true,"data":{"sessionId":"pi-session"}}` + "\n"},
		{Data: `{"type":"response","command":"prompt","success":true}` + "\n"},
		{Data: `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"work done"}]}}` + "\n"},
		{Data: `{"type":"agent_settled"}` + "\n"},
	}})
	t.Setenv("CODEAGENT_PI_COMMAND", "pi-test-binary")
	var capturedCommand string
	var capturedArgs []string
	newCommandRunner = func(_ context.Context, command string, args ...string) commandRunner {
		capturedCommand = command
		capturedArgs = append([]string(nil), args...)
		return fake
	}
	result := runCodexTaskWithContext(context.Background(), TaskSpec{
		Backend: "pi", Task: "run\n@not-a-file", WorkDir: "/tmp/work", PiModel: "provider/model",
	}, nil, nil, false, false, 2)
	if result.ExitCode != 0 || result.Message != "work done" || result.SessionID != "pi-session" {
		t.Fatalf("unexpected result: %+v", result)
	}
	wantArgs := []string{"--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-mcp", "--model", "provider/model"}
	if got := strings.Join(capturedArgs, "\x00"); got != strings.Join(wantArgs, "\x00") {
		t.Errorf("executed Pi args mismatch: %q", capturedArgs)
	}
	if capturedCommand != "pi-test-binary" {
		t.Errorf("executed command = %q, want Pi binary", capturedCommand)
	}
	if !fake.stdinWriter.closed {
		t.Fatal("settled RPC did not close stdin")
	}
	var commands []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(fake.StdinContents()), "\n") {
		var command map[string]any
		if err := json.Unmarshal([]byte(line), &command); err != nil {
			t.Fatalf("decode RPC command: %v; stdin=%q", err, fake.StdinContents())
		}
		commands = append(commands, command)
	}
	if len(commands) != 2 || commands[1]["message"] != "run\n@not-a-file" {
		t.Fatalf("unexpected RPC stdin: %q", fake.StdinContents())
	}
}

func TestRunPiRPCStdinWriteErrorIsFailure(t *testing.T) {
	defer resetTestHooks()
	fake := newFakeCmd(fakeCmdConfig{StdoutPlan: []fakeStdoutEvent{
		{Data: `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"should not be success"}]}}` + "\n"},
		{Data: `{"type":"agent_settled"}` + "\n"},
	}})
	if err := fake.stdinWriter.Close(); err != nil {
		t.Fatal(err)
	}
	newCommandRunner = func(context.Context, string, ...string) commandRunner { return fake }
	result := runCodexTaskWithContext(context.Background(), TaskSpec{Backend: "pi", Task: "preserve this prompt", WorkDir: "/tmp/work"}, nil, nil, false, false, 2)
	if result.ExitCode == 0 || !strings.Contains(result.Error, "write Pi RPC stdin") {
		t.Fatalf("stdin failure must not return success: %+v", result)
	}
}

func TestRunPiRPCMissingSettlementIsFailure(t *testing.T) {
	defer resetTestHooks()
	fake := newFakeCmd(fakeCmdConfig{StdoutPlan: []fakeStdoutEvent{
		{Data: `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"partial"}]}}` + "\n"},
	}})
	newCommandRunner = func(context.Context, string, ...string) commandRunner { return fake }
	result := runCodexTaskWithContext(context.Background(), TaskSpec{Backend: "pi", Task: "task", WorkDir: "/tmp/work"}, nil, nil, false, false, 2)
	if result.ExitCode == 0 || !strings.Contains(result.Error, "before agent_settled") {
		t.Fatalf("missing settlement must not return success: %+v", result)
	}
}

func TestRunPiRPCCancellation(t *testing.T) {
	defer resetTestHooks()
	forceKillDelay.Store(0)
	fake := newFakeCmd(fakeCmdConfig{
		KeepStdoutOpen:      true,
		BlockWait:           true,
		ReleaseWaitOnSignal: true,
		ReleaseWaitOnKill:   true,
	})
	newCommandRunner = func(context.Context, string, ...string) commandRunner { return fake }
	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel()
	result := runCodexTaskWithContext(ctx, TaskSpec{Backend: "pi", Task: "wait", WorkDir: "/tmp/work"}, nil, nil, false, false, 10)
	if result.ExitCode != 124 {
		t.Fatalf("cancel result = %+v, want timeout", result)
	}
	if fake.process.SignalCount() == 0 || !fake.stdinWriter.closed {
		t.Fatalf("cancellation did not clean up: signals=%d, stdinClosed=%t", fake.process.SignalCount(), fake.stdinWriter.closed)
	}
}
