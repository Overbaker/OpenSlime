package main

import (
	"encoding/json"
	"os"
	"strings"
)

// PiBackend runs Pi as a local JSON-RPC process. Pi itself can use any of its
// configured local or remote model providers; that provider connection does not
// change the wrapper's process lifecycle.
type PiBackend struct{}

func (PiBackend) Name() string { return "pi" }

func (PiBackend) Command() string {
	if cmd := strings.TrimSpace(os.Getenv("CODEAGENT_PI_COMMAND")); cmd != "" {
		return cmd
	}
	return "pi"
}

func (PiBackend) BuildArgs(cfg *Config, targetArg string) []string {
	return buildPiArgs(cfg, targetArg)
}

func buildPiArgs(cfg *Config, _ string) []string {
	if cfg == nil {
		return nil
	}

	// Prompts are sent through the RPC prompt command, never argv. In
	// particular, this avoids Pi interpreting an @file argument or cmd.exe
	// modifying a multiline prompt. Interactive extensions are disabled because
	// RPC callers cannot answer extension UI requests.
	args := []string{"--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates"}
	if !cfg.WithMCP {
		args = append(args, "--no-mcp")
	}
	if cfg.Mode == "resume" {
		args = append(args, "--session", strings.TrimSpace(cfg.SessionID))
	}
	if model := strings.TrimSpace(cfg.PiModel); model != "" {
		args = append(args, "--model", model)
	}
	return args
}

func buildPiRPCInput(task string) (string, error) {
	commands := []any{
		map[string]any{"id": "ccg-state", "type": "get_state"},
		map[string]any{"id": "ccg-prompt", "type": "prompt", "message": task},
	}
	var input strings.Builder
	for _, command := range commands {
		data, err := json.Marshal(command)
		if err != nil {
			return "", err
		}
		input.Write(data)
		input.WriteByte('\n')
	}
	return input.String(), nil
}
