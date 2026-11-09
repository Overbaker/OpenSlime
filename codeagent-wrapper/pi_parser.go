package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
)

type piRPCEvent struct {
	Type    string          `json:"type"`
	Command string          `json:"command"`
	Success *bool           `json:"success"`
	Error   string          `json:"error"`
	Message json.RawMessage `json:"message"`
	Data    json.RawMessage `json:"data"`
}

type piMessage struct {
	Role       string `json:"role"`
	StopReason string `json:"stopReason"`
	Error      string `json:"errorMessage"`
	Content    []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
}

type piStreamCallbacks struct {
	onMessage        func()
	onComplete       func()
	onContent        func(content, contentType string)
	onProgress       func(line string)
	onSessionStarted func(id string)
}

func piResponseError(event piRPCEvent) error {
	if event.Success != nil && *event.Success {
		return nil
	}
	message := strings.TrimSpace(event.Error)
	if message == "" && len(event.Message) > 0 {
		_ = json.Unmarshal(event.Message, &message)
		message = strings.TrimSpace(message)
	}
	if message == "" && len(event.Data) > 0 {
		var data struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(event.Data, &data) == nil {
			message = strings.TrimSpace(data.Error)
		}
	}
	if message == "" {
		message = "command failed"
	}
	if event.Command != "" {
		return fmt.Errorf("%s: %s", event.Command, message)
	}
	return errors.New(message)
}

func piMessageText(message piMessage) string {
	var text strings.Builder
	for _, part := range message.Content {
		if part.Type == "text" {
			text.WriteString(part.Text)
		}
	}
	return text.String()
}

// parsePiRPCStream parses Pi's bidirectional RPC protocol. RPC has no session
// header, so the session ID comes from the get_state command response.
func parsePiRPCStream(r io.Reader, warnFn, infoFn func(string), callbacks piStreamCallbacks) parseResult {
	if warnFn == nil {
		warnFn = func(string) {}
	}
	if infoFn == nil {
		infoFn = func(string) {}
	}
	notifyMessage := func() {
		if callbacks.onMessage != nil {
			callbacks.onMessage()
		}
	}
	notifyComplete := func() {
		if callbacks.onComplete != nil {
			callbacks.onComplete()
		}
	}
	emitProgress := func(event string, fields map[string]string) {
		if callbacks.onProgress != nil {
			callbacks.onProgress("[PROGRESS] " + formatProgressLine(event, fields))
		}
	}

	reader := bufio.NewReaderSize(r, jsonLineReaderSize)
	var result parseResult
	streamedText := false
	completionSignalled := false
	setError := func(err error) {
		if err != nil && result.err == nil {
			result.err = err
		}
	}
	complete := func() {
		if completionSignalled {
			return
		}
		completionSignalled = true
		notifyComplete()
	}
	totalEvents := 0

	for {
		line, tooLong, readErr := readLineWithLimit(reader, jsonLineMaxBytes, jsonLinePreviewBytes)
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				if !completionSignalled {
					setError(errors.New("Pi RPC stream ended before agent_settled"))
				}
				break
			}
			// A process/pipe may report ErrClosedPipe while its stdin and stdout
			// are being torn down after settlement; do not discard real errors.
			if completionSignalled && result.err == nil {
				break
			}
			setError(fmt.Errorf("read Pi RPC output: %w", readErr))
			break
		}
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		totalEvents++
		if tooLong {
			warnFn(fmt.Sprintf("Skipped overlong Pi RPC line (> %d bytes)", jsonLineMaxBytes))
			continue
		}

		var event piRPCEvent
		if err := json.Unmarshal(line, &event); err != nil {
			warnFn(fmt.Sprintf("Failed to parse Pi RPC event: %s", truncateBytes(line, 100)))
			continue
		}

		switch event.Type {
		case "response":
			if err := piResponseError(event); err != nil {
				setError(err)
				if event.Command == "prompt" || event.Command == "get_state" {
					complete()
				}
				continue
			}
			if event.Command != "get_state" || len(event.Data) == 0 {
				continue
			}
			var state struct {
				SessionID string `json:"sessionId"`
			}
			if err := json.Unmarshal(event.Data, &state); err != nil {
				setError(fmt.Errorf("get_state: invalid response: %w", err))
				complete()
				continue
			}
			if state.SessionID != "" && result.threadID == "" {
				result.threadID = state.SessionID
				infoFn("Pi RPC session started: " + state.SessionID)
				emitProgress("session_started", map[string]string{"id": state.SessionID})
				if callbacks.onSessionStarted != nil {
					callbacks.onSessionStarted(state.SessionID)
				}
			}

		case "agent_start":
			emitProgress("turn_started", nil)

		case "message_update":
			var payload struct {
				AssistantEvent struct {
					Type      string `json:"type"`
					Delta     string `json:"delta"`
					TextDelta string `json:"textDelta"`
					Content   string `json:"content"`
				} `json:"assistantEvent"`
			}
			if json.Unmarshal(line, &payload) != nil {
				continue
			}
			update := payload.AssistantEvent
			if update.Type != "text_delta" && update.Type != "text_start" && update.Type != "text_end" {
				continue
			}
			text := update.Delta
			if text == "" {
				text = update.TextDelta
			}
			if text == "" && update.Type != "text_delta" {
				text = update.Content
			}
			if text != "" {
				streamedText = true
				notifyMessage()
				if callbacks.onContent != nil {
					callbacks.onContent(text, "message")
				}
			}

		case "message_end":
			var payload struct {
				Message piMessage `json:"message"`
			}
			if err := json.Unmarshal(line, &payload); err != nil {
				warnFn("Failed to parse Pi message_end event: " + err.Error())
				continue
			}
			message := payload.Message
			if message.Role != "assistant" {
				continue
			}
			text := piMessageText(message)
			if text != "" {
				result.message = text
				notifyMessage()
				emitProgress("message", map[string]string{"text": strconv.Quote(safeProgressSnippet(text, 120))})
				if callbacks.onContent != nil && !streamedText {
					callbacks.onContent(text, "message")
				}
			}
			streamedText = false
			switch message.StopReason {
			case "error", "aborted":
				detail := strings.TrimSpace(message.Error)
				if detail == "" {
					detail = message.StopReason
				}
				setError(errors.New("Pi assistant stopped: " + detail))
			}

		case "tool_execution_start":
			var payload struct {
				ToolName string `json:"toolName"`
			}
			if json.Unmarshal(line, &payload) == nil && payload.ToolName != "" {
				emitProgress("tool_started", map[string]string{"cmd": strconv.Quote(payload.ToolName)})
			}

		case "tool_execution_end":
			var payload struct {
				ToolName string          `json:"toolName"`
				IsError  bool            `json:"isError"`
				Result   json.RawMessage `json:"result"`
			}
			if json.Unmarshal(line, &payload) == nil {
				emitProgress("tool_done", map[string]string{"cmd": strconv.Quote(payload.ToolName)})
			}

		case "auto_retry_start":
			var payload struct {
				Attempt    int    `json:"attempt"`
				MaxRetries int    `json:"maxRetries"`
				Error      string `json:"error"`
			}
			if json.Unmarshal(line, &payload) == nil {
				emitProgress("retry", map[string]string{"text": strconv.Quote(safeProgressSnippet(payload.Error, 120))})
			}

		case "auto_retry_end":
			var payload struct {
				Success bool   `json:"success"`
				Error   string `json:"error"`
			}
			if json.Unmarshal(line, &payload) == nil && !payload.Success {
				detail := strings.TrimSpace(payload.Error)
				if detail == "" {
					detail = "retries exhausted"
				}
				setError(errors.New("Pi request failed: " + detail))
			}

		case "agent_settled":
			emitProgress("session_completed", map[string]string{"total_events": strconv.Itoa(totalEvents)})
			complete()
		}
	}

	infoFn(fmt.Sprintf("Pi RPC parse completed: events=%d, message_len=%d, session_id_found=%t", totalEvents, len(result.message), result.threadID != ""))
	return result
}
