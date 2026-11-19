package main

import "time"

// processTimesLookup returns a process's creation time (any monotonic unit)
// and its CPU time; ok is false when the process cannot be read.
type processTimesLookup func(pid uint32) (created uint64, cpu time.Duration, ok bool)

// sumDescendantCPU walks children from root and sums the CPU of every
// descendant, root excluded. Parent pids can outlive their process and pids
// are recycled (Windows), so a child created before its parent is not a real
// child: it is skipped together with its subtree. A child that cannot be read
// counts 0, and its own children are compared against the last known creation
// time above it. Each pid is visited once, so pid cycles terminate.
func sumDescendantCPU(root uint32, rootCreated uint64, children map[uint32][]uint32, times processTimesLookup) time.Duration {
	type candidate struct {
		pid           uint32
		parentCreated uint64
	}
	seen := map[uint32]bool{root: true}
	var queue []candidate
	for _, child := range children[root] {
		queue = append(queue, candidate{child, rootCreated})
	}
	var total time.Duration
	for len(queue) > 0 {
		c := queue[0]
		queue = queue[1:]
		if seen[c.pid] {
			continue
		}
		seen[c.pid] = true
		created, cpu, ok := times(c.pid)
		if ok {
			if created < c.parentCreated {
				continue
			}
			total += cpu
		} else {
			created = c.parentCreated
		}
		for _, child := range children[c.pid] {
			queue = append(queue, candidate{child, created})
		}
	}
	return total
}
