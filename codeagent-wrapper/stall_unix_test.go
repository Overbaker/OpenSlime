//go:build unix || darwin || linux

package main

import (
	"testing"
	"time"
)

func TestDescendantCPUParsePSTime(t *testing.T) {
	cases := map[string]time.Duration{
		"00:01.50":   1500 * time.Millisecond,
		"0:00.00":    0,
		"01:02:03":   time.Hour + 2*time.Minute + 3*time.Second,
		"1-02:03:04": 26*time.Hour + 3*time.Minute + 4*time.Second,
	}
	for in, want := range cases {
		got, ok := parsePSCPUTime(in)
		if !ok || got != want {
			t.Errorf("parsePSCPUTime(%q) = %v, %v; want %v", in, got, ok, want)
		}
	}
	for _, bad := range []string{"", "abc", "1:2:3:4", "x-01:02"} {
		if _, ok := parsePSCPUTime(bad); ok {
			t.Errorf("parsePSCPUTime(%q) should fail", bad)
		}
	}
}
