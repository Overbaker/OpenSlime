package main

import (
	"context"
	"fmt"
	"math/rand"
	"strings"
	"testing"
)

// Fixtures modelled on claude 2.1.328 `--output-format stream-json --verbose` lines.
const (
	claudeSID          = "5c0e8f9a-1b2c-4d3e-9f80-a1b2c3d4e5f6"
	claudeInitLine     = `{"type":"system","subtype":"init","cwd":"/tmp/proj","session_id":"` + claudeSID + `","tools":["Bash","Read","Edit"],"mcp_servers":[],"model":"claude-opus-4-5","permissionMode":"bypassPermissions","slash_commands":["compact"],"apiKeySource":"none","claude_code_version":"2.1.328","output_style":"default","agents":[],"skills":[],"plugins":[],"uuid":"0f1e2d3c-0000-4000-8000-000000000001"}`
	claudeToolUseLine  = `{"type":"assistant","message":{"model":"claude-opus-4-5","id":"msg_01A","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01X","name":"Bash","input":{"command":"ls -la","description":"List files"}}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":4,"cache_creation_input_tokens":120,"cache_read_input_tokens":9000,"output_tokens":60,"service_tier":"standard"},"context_management":null},"parent_tool_use_id":null,"session_id":"` + claudeSID + `","uuid":"0f1e2d3c-0000-4000-8000-000000000002"}`
	claudeThinkingLine = `{"type":"assistant","message":{"model":"claude-opus-4-5","id":"msg_01B","type":"message","role":"assistant","content":[{"type":"thinking","thinking":"I should list the files first.","signature":"EqoBCkYIBRgCKkB"}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":4,"output_tokens":12}},"parent_tool_use_id":null,"session_id":"` + claudeSID + `","uuid":"0f1e2d3c-0000-4000-8000-000000000003"}`
	claudeToolProgress = `{"type":"tool_progress","tool_use_id":"toolu_01X","tool_name":"Bash","parent_tool_use_id":null,"elapsed_time_seconds":30,"session_id":"` + claudeSID + `","uuid":"0f1e2d3c-0000-4000-8000-000000000004"}`
	claudeToolResult   = `{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01X","type":"tool_result","content":"total 8\nREADME.md","is_error":false}]},"parent_tool_use_id":null,"session_id":"` + claudeSID + `","uuid":"0f1e2d3c-0000-4000-8000-000000000005","tool_use_result":{"stdout":"total 8\nREADME.md","stderr":"","interrupted":false,"isImage":false}}`
	claudeTextLine     = `{"type":"assistant","message":{"model":"claude-opus-4-5","id":"msg_01C","type":"message","role":"assistant","content":[{"type":"text","text":"The directory contains README.md."}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":4,"output_tokens":9}},"parent_tool_use_id":null,"session_id":"` + claudeSID + `","uuid":"0f1e2d3c-0000-4000-8000-000000000006"}`
	claudeRateAllowed  = `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1763600000,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false},"uuid":"0f1e2d3c-0000-4000-8000-000000000007","session_id":"` + claudeSID + `"}`
	claudeRateRejected = `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1763600000,"rateLimitType":"five_hour","isUsingOverage":false},"uuid":"0f1e2d3c-0000-4000-8000-000000000008","session_id":"` + claudeSID + `"}`
	claudeResultOK     = `{"type":"result","subtype":"success","is_error":false,"duration_ms":15234,"duration_api_ms":14010,"num_turns":3,"result":"The directory contains README.md.","session_id":"` + claudeSID + `","total_cost_usd":0.0421,"usage":{"input_tokens":12,"output_tokens":81},"modelUsage":{},"permission_denials":[],"uuid":"0f1e2d3c-0000-4000-8000-000000000009"}`
	claudeResultError  = `{"type":"result","subtype":"error_during_execution","is_error":true,"duration_ms":812,"duration_api_ms":0,"num_turns":1,"session_id":"` + claudeSID + `","total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0},"modelUsage":{},"permission_denials":[],"errors":["boom"],"uuid":"0f1e2d3c-0000-4000-8000-00000000000a"}`
)

type claudeParseOutcome struct {
	message   string
	threadID  string
	failure   string
	progress  []string
	messages  int
	completes int
}

func parseClaudeFixture(lines []string, withProgress bool) claudeParseOutcome {
	var out claudeParseOutcome
	var onProgress func(string)
	if withProgress {
		onProgress = func(line string) { out.progress = append(out.progress, line) }
	}
	stream := strings.Join(lines, "\n") + "\n"
	out.message, out.threadID = parseJSONStreamWithFailure(strings.NewReader(stream), nil, nil,
		func() { out.messages++ }, func() { out.completes++ }, nil, onProgress, nil,
		func(reason string) { out.failure = reason })
	return out
}

func TestClaudeProgressLines(t *testing.T) {
	lines := []string{
		claudeInitLine, claudeRateAllowed, claudeThinkingLine, claudeToolUseLine, claudeToolProgress,
		claudeToolResult, claudeTextLine, claudeRateRejected, claudeResultOK,
	}
	out := parseClaudeFixture(lines, true)
	want := []string{
		"[PROGRESS] session_started id=" + claudeSID,
		"[PROGRESS] tool_use tool=Bash",
		`[PROGRESS] message text="The directory contains README.md."`,
		"[PROGRESS] rate_limit status=rejected",
		fmt.Sprintf("[PROGRESS] session_completed total_events=%d", len(lines)),
	}
	if strings.Join(out.progress, "\n") != strings.Join(want, "\n") {
		t.Fatalf("progress lines:\n%s\nwant:\n%s", strings.Join(out.progress, "\n"), strings.Join(want, "\n"))
	}
	if out.message != "The directory contains README.md." || out.threadID != claudeSID || out.failure != "" {
		t.Fatalf("unexpected outcome %+v", out)
	}
	if out.messages != 1 || out.completes != 1 {
		t.Fatalf("notify counts message=%d complete=%d, want 1/1", out.messages, out.completes)
	}
}

func TestClaudeProgressTextTruncated(t *testing.T) {
	long := strings.Repeat("é", 300)
	line := strings.Replace(claudeTextLine, "The directory contains README.md.", long, 1)
	out := parseClaudeFixture([]string{line}, true)
	if len(out.progress) != 1 {
		t.Fatalf("progress = %v", out.progress)
	}
	text := strings.TrimPrefix(out.progress[0], "[PROGRESS] message text=")
	if n := len([]rune(strings.Trim(text, `"`))); n > 120 {
		t.Fatalf("snippet has %d runes", n)
	}
}

func TestClaudeProgressNoHeartbeatLines(t *testing.T) {
	out := parseClaudeFixture([]string{claudeToolProgress, claudeThinkingLine, claudeToolResult, claudeRateAllowed}, true)
	if len(out.progress) != 0 {
		t.Fatalf("unexpected progress lines %v", out.progress)
	}
}

func TestClaudeProgressErrorResult(t *testing.T) {
	out := parseClaudeFixture([]string{claudeInitLine, claudeResultError}, false)
	if out.message != "" || out.failure != "error_during_execution" || out.threadID != claudeSID {
		t.Fatalf("unexpected outcome %+v", out)
	}
}

func TestClaudeProgressIncomplete(t *testing.T) {
	out := parseClaudeFixture([]string{claudeInitLine, claudeToolUseLine, claudeToolResult, claudeTextLine}, false)
	if out.message != "" || out.failure != "INCOMPLETE: claude exited without a result event" || out.threadID != claudeSID {
		t.Fatalf("unexpected outcome %+v", out)
	}
}

func TestClaudeProgressSignatureUnchanged(t *testing.T) {
	msg, tid := parseJSONStreamInternalWithContent(strings.NewReader(claudeInitLine+"\n"+claudeTextLine+"\n"+claudeResultOK+"\n"), nil, nil, nil, nil, nil, nil, nil)
	if msg != "The directory contains README.md." || tid != claudeSID {
		t.Fatalf("msg=%q tid=%q", msg, tid)
	}
}

func TestClaudeProgressFormatKeyOrder(t *testing.T) {
	got := formatProgressLine("e", map[string]string{"total_events": "3", "exit": "0", "cmd": "c", "text": "t", "status": "s", "tool": "x", "id": "i"})
	if got != "e id=i tool=x status=s text=t cmd=c exit=0 total_events=3" {
		t.Fatalf("got %q", got)
	}
}

// P7: --progress and claude assistant parsing never change message, session ID or exit code.
func TestClaudeProgressDoesNotChangeResult(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	middle := []string{claudeToolUseLine, claudeThinkingLine, claudeToolProgress, claudeToolResult, claudeTextLine, claudeRateAllowed, claudeRateRejected}
	endings := [][]string{{claudeResultOK}, {claudeResultError}, nil}
	for i := 0; i < 200; i++ {
		lines := []string{claudeInitLine}
		for n := rng.Intn(12); n > 0; n-- {
			lines = append(lines, middle[rng.Intn(len(middle))])
		}
		lines = append(lines, endings[rng.Intn(len(endings))]...)
		plain := parseClaudeFixture(lines, false)
		withProgress := parseClaudeFixture(lines, true)
		if plain.message != withProgress.message || plain.threadID != withProgress.threadID || plain.failure != withProgress.failure ||
			plain.messages != withProgress.messages || plain.completes != withProgress.completes {
			t.Fatalf("iteration %d: outcome differs\nplain=%+v\nprogress=%+v", i, plain, withProgress)
		}
		if strings.Contains(plain.message, "The directory contains") && !strings.Contains(strings.Join(lines, ""), `"result":"The directory`) {
			t.Fatalf("iteration %d: assistant text used as result", i)
		}
	}
}

func runClaudeFakeTask(t *testing.T, lines []string, progress bool) (TaskResult, string) {
	t.Helper()
	setupStallTest(t, 0, 0)
	codexCommand = "claude"
	plan := []fakeStdoutEvent{{Data: strings.Join(lines, "\n") + "\n"}}
	useFake(healthyPlanFake(plan))
	var res TaskResult
	stderr := captureStderr(t, func() {
		res = runCodexTaskWithContext(context.Background(), TaskSpec{Task: "claude-task", WorkDir: defaultWorkdir, Progress: progress}, nil, nil, false, true, 60)
	})
	return res, stderr
}

func TestClaudeProgressExecutorFailures(t *testing.T) {
	t.Run("error result", func(t *testing.T) {
		res, _ := runClaudeFakeTask(t, []string{claudeInitLine, claudeResultError}, false)
		if res.ExitCode != 1 || !strings.HasPrefix(res.Error, "claude failed: error_during_execution") || res.SessionID != claudeSID {
			t.Fatalf("unexpected result %+v", res)
		}
	})
	t.Run("interrupted", func(t *testing.T) {
		res, _ := runClaudeFakeTask(t, []string{claudeInitLine, claudeToolUseLine, claudeTextLine}, false)
		if res.ExitCode != 1 || !strings.HasPrefix(res.Error, "INCOMPLETE: claude exited without a result event") || res.SessionID != claudeSID {
			t.Fatalf("unexpected result %+v", res)
		}
	})
	t.Run("tool call visible", func(t *testing.T) {
		res, stderr := runClaudeFakeTask(t, []string{claudeInitLine, claudeToolUseLine, claudeToolResult, claudeTextLine, claudeResultOK}, true)
		if res.ExitCode != 0 || res.Message != "The directory contains README.md." || res.SessionID != claudeSID {
			t.Fatalf("unexpected result %+v", res)
		}
		if !strings.Contains(stderr, "[PROGRESS] tool_use tool=Bash") {
			t.Fatalf("stderr missing tool_use line: %q", stderr)
		}
	})
}
