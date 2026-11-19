//go:build linux

package main

import (
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"testing"
	"time"
)

func TestDescendantCPUTimeLinuxBusyLoop(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("sh not available")
	}
	// The leader sleeps; its busy child is the descendant that must be counted.
	cmd := exec.Command("sh", "-c", "sh -c 'while :; do :; done' & wait")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	pid := cmd.Process.Pid
	defer func() {
		_ = syscall.Kill(-pid, syscall.SIGKILL)
		_ = cmd.Wait()
	}()

	first, ok := descendantCPUTime(pid)
	if !ok {
		t.Fatalf("descendantCPUTime failed")
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(200 * time.Millisecond)
		now, ok := descendantCPUTime(pid)
		if !ok {
			t.Fatalf("descendantCPUTime failed")
		}
		if now > first {
			return
		}
	}
	t.Fatalf("descendant CPU time did not rise from %v", first)
}

// startCPUTree starts script under sh in its own process group and returns
// its pid plus a cleanup that kills the whole parent-pid tree.
func startCPUTree(t *testing.T, script string) int {
	t.Helper()
	cmd := exec.Command("sh", "-c", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	pid := cmd.Process.Pid
	t.Cleanup(func() {
		for i := 0; i < 5; i++ {
			parentOf := map[int]int{}
			entries, _ := os.ReadDir("/proc")
			for _, e := range entries {
				p, err := strconv.Atoi(e.Name())
				if err != nil {
					continue
				}
				if st, ok := readProcCPUStat(p); ok {
					parentOf[p] = st.ppid
				}
			}
			kids := descendantPIDs(pid, parentOf)
			if len(kids) == 0 {
				break
			}
			for _, k := range kids {
				_ = syscall.Kill(k, syscall.SIGKILL)
			}
			time.Sleep(20 * time.Millisecond)
		}
		_ = syscall.Kill(-pid, syscall.SIGKILL)
		_ = cmd.Wait()
	})
	return pid
}

func measureCPUIncrease(t *testing.T, pid int, d time.Duration) time.Duration {
	t.Helper()
	time.Sleep(100 * time.Millisecond)
	first, ok := descendantCPUTime(pid)
	if !ok {
		t.Fatalf("descendantCPUTime failed")
	}
	time.Sleep(d)
	last, ok := descendantCPUTime(pid)
	if !ok {
		t.Fatalf("descendantCPUTime failed")
	}
	return last - first
}

func TestDescendantCPUTimeShortLivedChildren(t *testing.T) {
	pid := startCPUTree(t, `sh -c 'while :; do sh -c "i=0; while [ \$i -lt 20000 ]; do i=\$((i+1)); done"; done' & wait`)
	if inc := measureCPUIncrease(t, pid, 3*time.Second); inc < time.Second {
		t.Fatalf("CPU increase over 3s = %v, want >= 1s", inc)
	}
}

func TestDescendantCPUTimeSetsidChild(t *testing.T) {
	if _, err := exec.LookPath("setsid"); err != nil {
		t.Skip("setsid not available")
	}
	pid := startCPUTree(t, `setsid sh -c 'while :; do :; done' & wait`)
	if inc := measureCPUIncrease(t, pid, 2*time.Second); inc < time.Second {
		t.Fatalf("CPU increase over 2s = %v, want >= 1s", inc)
	}
}
