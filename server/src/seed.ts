// Seeding — two separate jobs that happen to share this file's content helpers.
//
//  1. `seedNewUser(userId)` — called by POST /api/auth/signup. Gives a brand-new
//     account a starter notebook and makes sure the shared built-in templates exist,
//     so the app is never a dead-end empty screen on first login.
//  2. The demo vault (`seedDemoVault`) — a realistic 2nd-year CompSci vault, run from
//     the CLI so a dev install has something worth looking at.
//
// The vault used to run at import time. It cannot any more: routes/auth.ts imports
// `seedNewUser` from this module, so a top-level `main()` would seed 15 demo notes on
// every server boot. It is now behind an "am I the entry point?" guard.
//
// Run the demo vault: npm run seed -w server     (or: ... -- --force)

import { pathToFileURL } from 'node:url';
import { db, migrate, newId, nowIso, tx } from './db.js';
import { markdownToTipTap, markdownToPlainText, stripLeadingTitleHeading } from './lib/markdown.js';
import { syncLinksForNote } from './lib/links.js';
import { seedBuiltinTemplates } from './routes/templates.js';
import { hashPassword } from './auth/password.js';

const FORCE = process.argv.includes('--force');

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();
const isoIn = (ms: number) => new Date(Date.now() + ms).toISOString();
const L = (...lines: string[]) => lines.join('\n');

// ---------------------------------------------------------------------------------
// Note content — real, substantive 2nd-year CompSci material, written as Markdown.
// Converted to TipTap JSON + plain text at insert time via lib/markdown.ts.
// ---------------------------------------------------------------------------------

const bigOMarkdown = L(
  '# Big-O Notation & Complexity Analysis',
  '',
  "Big-O notation describes how an algorithm's running time or space requirement grows as the input size `n` grows. It captures the **worst-case upper bound**, ignoring constant factors and lower-order terms — which is exactly what matters once `n` gets large.",
  '',
  '## Why we drop constants',
  '',
  "An algorithm that does `3n + 7` operations and one that does `n` operations are both O(n), because for large `n` the constant factor and the `+7` become irrelevant compared to how the *shape* of the curve changes. What we care about is: does doubling the input roughly double the work (linear), square it (quadratic), or barely change it (logarithmic)?",
  '',
  '## Common complexity classes',
  '',
  '| Notation | Name | Example |',
  '|---|---|---|',
  '| O(1) | Constant | Array index lookup, hash table get |',
  '| O(log n) | Logarithmic | Binary search, balanced tree lookup (see [[B-Trees and Balanced Search Trees]]) |',
  '| O(n) | Linear | Single loop over an array |',
  '| O(n log n) | Linearithmic | Merge sort, quicksort average case (see [[Sorting Algorithms Compared]]) |',
  '| O(n²) | Quadratic | Nested loops, bubble sort |',
  '| O(2ⁿ) | Exponential | Naive recursive Fibonacci, brute-force subset generation |',
  '',
  '## Worked example: binary search',
  '',
  'Binary search on a sorted array halves the search space every comparison, which is exactly what gives it O(log n):',
  '',
  '```python',
  'def binary_search(arr, target):',
  '    lo, hi = 0, len(arr) - 1',
  '    while lo <= hi:',
  '        mid = (lo + hi) // 2',
  '        if arr[mid] == target:',
  '            return mid',
  '        elif arr[mid] < target:',
  '            lo = mid + 1',
  '        else:',
  '            hi = mid - 1',
  '    return -1',
  '```',
  '',
  "Each iteration discards half the remaining elements, so after `k` iterations only `n / 2^k` elements remain. Solving `n / 2^k = 1` gives `k = log2(n)` — hence O(log n).",
  '',
  '## Best, average, worst case',
  '',
  '- **Best case** — the most favourable input (rarely useful for planning capacity).',
  '- **Average case** — expected performance over a typical distribution of inputs; hardest to reason about rigorously.',
  '- **Worst case** — the guarantee. This is what Big-O almost always refers to unless stated otherwise.',
  '',
  '## Space complexity',
  '',
  'The same notation applies to memory. Recursive algorithms often have hidden O(n) space cost from the call stack even when the visible data structures look O(1) — this trips people up constantly with recursive Fibonacci or recursive tree traversals.',
  '',
  '## Exam tips',
  '',
  '- Always state *which* case you are analysing (worst-case unless told otherwise).',
  '- Amortised analysis (e.g. dynamic array `push`) is different again — occasional O(n) resizes averaged over many O(1) pushes still gives O(1) amortised.',
  '- Do not confuse Big-O (upper bound), Big-Ω (lower bound) and Big-Θ (tight bound) — Big-Θ is what you actually want when an algorithm’s best and worst case coincide.',
);

const sortingMarkdown = L(
  '# Sorting Algorithms Compared',
  '',
  "Every sorting algorithm trades off time complexity, space complexity, and **stability** (whether equal elements keep their original relative order). See [[Big-O Notation & Complexity Analysis]] for the notation used below.",
  '',
  '## Comparison table',
  '',
  '| Algorithm | Best | Average | Worst | Space | Stable? |',
  '|---|---|---|---|---|---|',
  '| Bubble sort | O(n) | O(n²) | O(n²) | O(1) | Yes |',
  '| Insertion sort | O(n) | O(n²) | O(n²) | O(1) | Yes |',
  '| Merge sort | O(n log n) | O(n log n) | O(n log n) | O(n) | Yes |',
  '| Quicksort | O(n log n) | O(n log n) | O(n²) | O(log n) | No |',
  '| Heapsort | O(n log n) | O(n log n) | O(n log n) | O(1) | No |',
  '',
  '## Merge sort — divide and conquer',
  '',
  '```python',
  'def merge_sort(arr):',
  '    if len(arr) <= 1:',
  '        return arr',
  '    mid = len(arr) // 2',
  '    left = merge_sort(arr[:mid])',
  '    right = merge_sort(arr[mid:])',
  '    return merge(left, right)',
  '',
  'def merge(left, right):',
  '    result, i, j = [], 0, 0',
  '    while i < len(left) and j < len(right):',
  '        # <= keeps it stable: left wins ties',
  '        if left[i] <= right[j]:',
  '            result.append(left[i]); i += 1',
  '        else:',
  '            result.append(right[j]); j += 1',
  '    return result + left[i:] + right[j:]',
  '```',
  '',
  'Merge sort always splits in half and always does O(n) work to merge, so its complexity never degrades — the trade-off is O(n) extra space for the merge buffers.',
  '',
  '## Quicksort — why the worst case matters',
  '',
  "Quicksort partitions around a pivot and recurses on each side. With a well-chosen pivot (e.g. median-of-three or randomised) it hits O(n log n) on average. But a naive 'always pick the first element' pivot on **already-sorted input** degrades to O(n²), because every partition splits off just one element instead of half the array. This is a classic exam trap: quicksort's reputation as 'the fast one' depends entirely on pivot choice.",
  '',
  '## When to use which',
  '',
  "- **Small or nearly-sorted arrays** — insertion sort's O(n) best case and low overhead often beats the 'better' algorithms in practice (this is why real-world sorts like Timsort fall back to insertion sort below ~64 elements).",
  '- **Need a stability guarantee** (e.g. sorting rows by one column, then another) — merge sort or a stable adaptation of insertion sort.',
  '- **Memory constrained, no stability requirement** — heapsort, guaranteed O(1) extra space and O(n log n) worst case.',
  '- **General purpose, average case matters more than worst case** — quicksort, which is why it is the default in many language standard libraries (with randomised or hybrid pivots to defang the O(n²) worst case).',
  '',
  '## Task list before the lab',
  '',
  '- [x] Implement merge sort from pseudocode',
  '- [x] Trace quicksort worst-case on a sorted 8-element array by hand',
  '- [ ] Benchmark bubble/insertion/quicksort on 100 / 10,000 / 1,000,000 elements and plot',
  "- [ ] Read about Timsort's real-world hybrid strategy",
);

const bTreesMarkdown = L(
  '# B-Trees and Balanced Search Trees',
  '',
  "A plain binary search tree degrades to O(n) lookup if it's built from already-sorted input (it becomes a linked list in disguise). Balanced trees fix this by guaranteeing height stays O(log n) regardless of insertion order — see [[Big-O Notation & Complexity Analysis]].",
  '',
  '## Why not just use a balanced binary tree everywhere?',
  '',
  "AVL trees and red-black trees keep height O(log n) with at most 2 children per node. That's great in memory, but databases don't live in memory — they live on disk, where reading a block is orders of magnitude slower than a memory access. A B-tree fans out with **many** children per node so the whole tree is much *shorter*, which means far fewer disk reads to reach a leaf. This is exactly why [[SQL Joins Explained]] indexes are B-trees (or B+trees), not binary trees.",
  '',
  '## B-tree properties (order / minimum degree t)',
  '',
  '1. Every node has at most `2t - 1` keys.',
  '2. Every node except the root has at least `t - 1` keys.',
  '3. All leaves appear at the same depth (this is what makes it balanced).',
  '4. A non-leaf node with `k` keys has exactly `k + 1` children.',
  '5. Keys within a node are kept sorted, and each child pointer sits between two keys, covering the range between them.',
  '',
  '## Insertion, briefly',
  '',
  "Insertion always starts at a leaf. If the leaf is full (`2t - 1` keys already), it **splits**: the median key moves up into the parent, and the leaf becomes two half-full nodes. If the split propagates all the way to a full root, the tree grows one level taller — and only at the root, which is why height stays balanced without any rebalancing pass like AVL's rotations.",
  '',
  '```text',
  'Insert into a full leaf [10, 20, 30] (t = 2, max 3 keys) with new key 25:',
  '  1. Node is full -> split around median 20',
  '  2. 20 moves up to parent',
  '  3. Leaf becomes [10] and [25, 30]',
  '```',
  '',
  '## B-tree vs B+tree',
  '',
  '- **B-tree**: data can live in internal nodes as well as leaves.',
  '- **B+tree**: all actual data lives in the leaves, which are additionally linked together in a chain. Internal nodes only hold routing keys. This makes **range scans** (`WHERE age BETWEEN 20 AND 30`) fast — walk to the first matching leaf, then follow the leaf chain — which is why B+trees, not plain B-trees, are what almost every real database index actually uses.',
  '',
  '## Exam-relevant comparison',
  '',
  '| Structure | Height for n items | Disk-friendly? | Rebalancing |',
  '|---|---|---|---|',
  '| Unbalanced BST | up to O(n) | No | None |',
  '| AVL tree | O(log₂ n), tightly balanced | Not really (2-way fan-out) | Rotations on every insert/delete |',
  '| Red-black tree | O(log₂ n), looser balance | Not really | Fewer rotations than AVL |',
  '| B-tree (order t) | O(log_t n) — much shallower | Yes — designed for it | Splits/merges, localised to a path |',
);

const sqlJoinsMarkdown = L(
  '# SQL Joins Explained',
  '',
  'A join combines rows from two or more tables based on a related column — almost always a foreign key. Understanding exactly which rows survive each join type is one of the most-tested pieces of the databases module.',
  '',
  '## Example schema',
  '',
  '```sql',
  'CREATE TABLE students (id INTEGER PRIMARY KEY, name TEXT);',
  'CREATE TABLE enrolments (student_id INTEGER, module_code TEXT,',
  '  FOREIGN KEY (student_id) REFERENCES students(id));',
  '```',
  '',
  "Say `students` has rows for Alice (1), Bob (2), and Cara (3), but `enrolments` only has rows for Alice and Bob — Cara hasn't enrolled in anything yet.",
  '',
  '## INNER JOIN',
  '',
  '```sql',
  'SELECT s.name, e.module_code',
  'FROM students s',
  'INNER JOIN enrolments e ON s.id = e.student_id;',
  '```',
  '',
  "Returns only rows where the join condition matches on **both** sides — Alice and Bob's rows, Cara is dropped entirely because she has no matching `enrolments` row.",
  '',
  '## LEFT (OUTER) JOIN',
  '',
  '```sql',
  'SELECT s.name, e.module_code',
  'FROM students s',
  'LEFT JOIN enrolments e ON s.id = e.student_id;',
  '```',
  '',
  "Keeps **every** row from the left table (`students`) regardless of a match, filling unmatched right-side columns with `NULL`. Cara now appears with `module_code = NULL`. This is the join to reach for whenever the question is 'show me all X, and whatever Y they might have' — e.g. 'list all students and their enrolments if any'.",
  '',
  '## RIGHT JOIN and FULL OUTER JOIN',
  '',
  "`RIGHT JOIN` is the mirror image of `LEFT JOIN` (keeps every row from the right table). `FULL OUTER JOIN` keeps unmatched rows from **both** sides. SQLite doesn't support `RIGHT`/`FULL OUTER` directly — swap table order for RIGHT, or emulate FULL OUTER with a `LEFT JOIN` unioned with the equivalent swapped `LEFT JOIN`.",
  '',
  '## Self joins',
  '',
  "A table can join to itself — useful for hierarchical data like 'find every pair of students in the same module':",
  '',
  '```sql',
  'SELECT e1.student_id, e2.student_id, e1.module_code',
  'FROM enrolments e1',
  'JOIN enrolments e2',
  '  ON e1.module_code = e2.module_code',
  ' AND e1.student_id < e2.student_id;',
  '```',
  '',
  'The `e1.student_id < e2.student_id` guard stops each pair being counted twice and stops a student pairing with themselves.',
  '',
  '## Joins and indexes',
  '',
  'A join without an index on the join column forces a full table scan on one side for every row on the other — O(n·m). An index (typically a [[B-Trees and Balanced Search Trees]]-style B+tree index) turns the lookup side into O(log n) per row, giving roughly O(n log m) overall. Always check `EXPLAIN QUERY PLAN` before assuming a slow join is the join type\'s fault rather than a missing index.',
  '',
  '## Related: normal forms',
  '',
  'How many joins a query needs is a direct consequence of how normalised the schema is — see [[Normalisation: 1NF to 3NF]]. More normalisation generally means more joins but less duplicated, inconsistent data.',
);

const normalisationMarkdown = L(
  '# Normalisation: 1NF to 3NF',
  '',
  'Normalisation is the process of structuring a relational schema to eliminate redundancy and the update anomalies that come with it (insert/update/delete anomalies). Each normal form fixes a specific class of problem — see [[SQL Joins Explained]] for the cost side of the trade-off (more normal forms usually means more joins).',
  '',
  '## Starting point: an unnormalised table',
  '',
  '| OrderID | Customer | CustomerEmail | Product1 | Product2 |',
  '|---|---|---|---|---|',
  '| 1 | Alice | alice@x.com | Pen | Notebook |',
  '| 2 | Bob | bob@x.com | Pen | NULL |',
  '',
  "This already breaks 1NF (repeating `Product1`/`Product2` groups instead of one row per product) and hides duplication (Alice's email is stored once per order she's ever placed).",
  '',
  '## First Normal Form (1NF)',
  '',
  '- Every column holds a single **atomic** value (no repeating groups, no comma-separated lists in one cell).',
  '- Fix: one row per (order, product) pair instead of `Product1`/`Product2` columns.',
  '',
  '| OrderID | Customer | CustomerEmail | Product |',
  '|---|---|---|---|',
  '| 1 | Alice | alice@x.com | Pen |',
  '| 1 | Alice | alice@x.com | Notebook |',
  '| 2 | Bob | bob@x.com | Pen |',
  '',
  '## Second Normal Form (2NF)',
  '',
  '- Must already be in 1NF.',
  "- No **partial dependency**: every non-key column must depend on the *whole* primary key, not just part of it. This only matters with a composite key — here the key is `(OrderID, Product)`, but `Customer`/`CustomerEmail` only depend on `OrderID`, not on `Product`. That's a partial dependency.",
  '- Fix: split into `Orders(OrderID, Customer, CustomerEmail)` and `OrderItems(OrderID, Product)`.',
  '',
  '## Third Normal Form (3NF)',
  '',
  '- Must already be in 2NF.',
  "- No **transitive dependency**: a non-key column can't depend on another non-key column. Here `CustomerEmail` depends on `Customer`, not directly on `OrderID` — that's transitive.",
  '- Fix: split further into `Orders(OrderID, CustomerID)` and `Customers(CustomerID, Customer, CustomerEmail)`.',
  '',
  '```sql',
  'CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, email TEXT);',
  'CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id));',
  'CREATE TABLE order_items (order_id INTEGER REFERENCES orders(id), product TEXT);',
  '```',
  '',
  '## The memorable one-liner',
  '',
  "> 'Every non-key attribute must depend on the key, the whole key, and nothing but the key — so help me Codd.'",
  '',
  "That's 1NF+2NF+3NF in one sentence: *the key* (1NF — atomic values addressable by the key), *the whole key* (2NF — no partial dependency on part of a composite key), *nothing but the key* (3NF — no transitive dependency through another non-key column).",
  '',
  '## When to denormalise',
  '',
  "Fully normalised schemas minimise redundancy but maximise joins. Read-heavy systems (analytics dashboards, reporting) sometimes deliberately denormalise — duplicating a customer's name onto the orders table, say — to avoid an expensive join on every read, accepting the update-anomaly risk because that data rarely changes.",
);

const acidMarkdown = L(
  '# ACID Transactions',
  '',
  'A transaction is a group of database operations that must succeed or fail **as a single unit**. ACID is the set of guarantees a database engine makes about every transaction.',
  '',
  '## Atomicity',
  '',
  "All operations in the transaction happen, or none do. If a bank transfer debits Alice £50 and the process crashes before crediting Bob, atomicity guarantees the debit is rolled back too — there's no state where the money just vanished.",
  '',
  '```sql',
  'BEGIN TRANSACTION;',
  'UPDATE accounts SET balance = balance - 50 WHERE id = 1;',
  'UPDATE accounts SET balance = balance + 50 WHERE id = 2;',
  'COMMIT;',
  '```',
  '',
  'If anything fails between `BEGIN` and `COMMIT`, `ROLLBACK` (explicit or automatic on crash) undoes both statements.',
  '',
  '## Consistency',
  '',
  "A transaction can only move the database from one valid state to another — it never leaves foreign keys dangling or a `CHECK` constraint violated. This is enforced by the schema's own rules (constraints, triggers), not something the transaction system provides on its own; Atomicity + Isolation are what actually make Consistency achievable.",
  '',
  '## Isolation',
  '',
  "Concurrent transactions shouldn't see each other's uncommitted, in-progress changes. The *degree* of isolation is configurable and each level trades correctness for concurrency:",
  '',
  '| Level | Dirty read? | Non-repeatable read? | Phantom read? |',
  '|---|---|---|---|',
  '| Read Uncommitted | Possible | Possible | Possible |',
  '| Read Committed | Prevented | Possible | Possible |',
  '| Repeatable Read | Prevented | Prevented | Possible |',
  '| Serializable | Prevented | Prevented | Prevented |',
  '',
  "- **Dirty read**: reading another transaction's uncommitted change.",
  '- **Non-repeatable read**: re-reading the same row twice in one transaction gives different values because another transaction committed a change in between.',
  '- **Phantom read**: re-running the same range query twice returns a different *set of rows* because another transaction inserted/deleted a matching row in between.',
  '',
  '## Durability',
  '',
  "Once a transaction commits, it survives a crash — even if the power dies one instruction later. Engines achieve this with a **write-ahead log (WAL)**: changes are appended to a durable log *before* being applied to the actual data pages, so a crash mid-write can be replayed from the log on restart. SQLite's WAL mode (which Folio itself runs in) is a direct application of this.",
  '',
  '## Isolation and deadlock',
  '',
  'Higher isolation levels use more locking, which increases the chance two transactions each hold a lock the other needs — a deadlock. See [[Deadlock: Conditions and Prevention]] for the general conditions; database engines typically resolve this by detecting the cycle and forcibly rolling back one of the transactions (a "deadlock victim"), which the application must be ready to retry.',
  '',
  '## Exam checklist',
  '',
  '- [x] Can define all four ACID properties without looking them up',
  '- [x] Can name the four anomalies (dirty/non-repeatable/phantom reads + lost update)',
  '- [ ] Can explain why WAL gives durability without fsync-ing every single page write',
);

const cpuSchedulingMarkdown = L(
  '# CPU Scheduling Algorithms',
  '',
  'The scheduler decides which ready process gets the CPU next. Every algorithm is a different answer to the same trade-off: throughput vs fairness vs responsiveness. Complexity classes from [[Big-O Notation & Complexity Analysis]] apply here too — most schedulers need O(log n) or O(1) per decision since they run extremely often.',
  '',
  '## First-Come, First-Served (FCFS)',
  '',
  'Processes run in arrival order, non-preemptive, until they finish or block. Trivial to implement (a plain queue) but suffers the **convoy effect**: one long CPU-bound process at the front makes every short process behind it wait, tanking average waiting time even though total throughput is fine.',
  '',
  '## Shortest Job First (SJF)',
  '',
  'Always runs whichever ready process has the shortest *next* CPU burst. Provably optimal for minimising average waiting time — but requires predicting the future (how long will this process run?), which in practice means estimating from past bursts (exponential averaging). Non-preemptive SJF can still starve long jobs if short jobs keep arriving.',
  '',
  '## Shortest Remaining Time First (SRTF)',
  '',
  'The preemptive version of SJF: if a new process arrives with a shorter remaining burst than the current one, it preempts immediately. Better average waiting time than SJF but more context-switch overhead, and long processes can starve indefinitely under a steady stream of short arrivals.',
  '',
  '## Round Robin',
  '',
  "Each process gets a fixed **time quantum**, then goes to the back of the queue if it hasn't finished. Fair and responsive — no starvation — but the quantum size is a real tuning problem:",
  '',
  '- Too large → degenerates toward FCFS (poor responsiveness).',
  '- Too small → most CPU time is lost to context-switch overhead rather than actual work.',
  '',
  '```text',
  'Quantum = 4, processes P1(burst 6), P2(burst 3), P3(burst 5), arrive together:',
  'Gantt: | P1(4) | P2(3) | P3(4) | P1(2) | P3(1) |',
  '       0       4       7       11      13      14',
  '```',
  '',
  '## Priority Scheduling',
  '',
  "Each process gets a priority number; highest priority runs first (preemptive or not). The classic failure mode is **starvation** of low-priority processes under continuous high-priority arrivals. The standard fix is **aging** — gradually increasing a waiting process's priority the longer it sits in the ready queue, guaranteeing it eventually runs.",
  '',
  '## Multilevel Feedback Queue',
  '',
  "Multiple Round Robin queues at different priority levels with different quanta. A process that uses its full quantum (looks CPU-bound) gets demoted to a lower-priority, longer-quantum queue; a process that blocks quickly (looks I/O-bound, interactive) stays high priority. This is the closest to what real operating systems (Linux's CFS is a more sophisticated relative) actually use, because it adapts to process behaviour without needing to predict burst times up front.",
  '',
  '## Comparison',
  '',
  '| Algorithm | Preemptive? | Starvation risk | Needs burst prediction? |',
  '|---|---|---|---|',
  '| FCFS | No | Low (fair by arrival) | No |',
  '| SJF | No | Yes (long jobs) | Yes |',
  '| SRTF | Yes | Yes (long jobs) | Yes |',
  '| Round Robin | Yes | No | No |',
  '| Priority (+ aging) | Either | No (with aging) | No |',
  '',
  "Related: once multiple processes compete for shared resources rather than just CPU time, scheduling decisions can contribute to [[Deadlock: Conditions and Prevention]] if resource allocation isn't handled carefully.",
);

const pagingMarkdown = L(
  '# Paging and Virtual Memory',
  '',
  'Virtual memory gives every process the illusion of a large, contiguous, private address space, regardless of how fragmented or small physical RAM actually is. Paging is the mechanism that makes this work.',
  '',
  '## The core idea',
  '',
  "Both virtual and physical memory are divided into fixed-size blocks: **pages** (virtual) and **frames** (physical), typically 4KB each. A **page table** maps each virtual page to a physical frame. The CPU's Memory Management Unit (MMU) does this translation on every single memory access, transparently to the running program.",
  '',
  '## Why fixed-size blocks?',
  '',
  'Fixed-size pages avoid **external fragmentation** — the problem where variable-sized memory allocation leaves lots of small, unusable gaps scattered around physical memory even when the *total* free space would be enough. Paging trades this for **internal fragmentation** instead: a process that needs 4097 bytes gets allocated two full 4KB pages, wasting most of the second page — a much smaller, more predictable cost.',
  '',
  '## Page table entries',
  '',
  'Each entry typically stores:',
  '',
  '- The physical frame number.',
  '- A **valid/invalid bit** — is this page actually mapped in, or would accessing it trigger a page fault?',
  '- A **dirty bit** — has this page been written to since it was loaded? (Determines whether it must be written back to disk before being evicted.)',
  '- **Protection bits** — read/write/execute permissions, enforced by hardware.',
  '',
  '## Page faults',
  '',
  'A page fault happens when a process accesses a page marked invalid — it is not currently in physical memory. The OS: (1) finds a free frame, or evicts one using a replacement policy if none is free, (2) reads the required page in from disk (the swap file/page file), (3) updates the page table, (4) resumes the instruction that faulted. This is transparent to the process — it has no idea a fault happened.',
  '',
  '## Page replacement policies',
  '',
  'When physical memory is full, something has to be evicted to make room:',
  '',
  "- **FIFO** — evict the oldest-loaded page. Simple, but can suffer *Belady's anomaly*: adding more physical frames can, counterintuitively, increase the fault rate.",
  '- **LRU (Least Recently Used)** — evict the page that has not been accessed for the longest time. Good approximation of future behaviour (temporal locality), but expensive to track exactly, so real systems approximate it (e.g. the clock/second-chance algorithm using a reference bit).',
  "- **Optimal (Belady's algorithm)** — evict the page that won't be used for the longest time in the future. Provably minimal fault rate, but requires knowing the future, so it is only useful as a theoretical benchmark to compare other policies against.",
  '',
  '## Thrashing',
  '',
  "If a process's **working set** (the pages it is actively using) does not fit in the frames it has been allocated, it spends more time handling page faults than doing actual work — CPU utilisation collapses even though every process appears busy. The fix is admission control: don't run more processes than the sum of their working sets allows to fit in physical memory.",
  '',
  '## Multi-level page tables',
  '',
  "A single flat page table for a 64-bit address space would be absurdly large. Multi-level (hierarchical) page tables split the virtual address into several index fields, each indexing into a smaller table, and only allocate the inner tables for address ranges a process actually uses — most of a huge sparse address space needs no page table entries at all.",
);

const deadlockMarkdown = L(
  '# Deadlock: Conditions and Prevention',
  '',
  'A deadlock is a set of processes each waiting for a resource held by another process in the same set, so **none of them can ever proceed**. Related to scheduling ([[CPU Scheduling Algorithms]]) and to database locking ([[ACID Transactions]]).',
  '',
  '## The four necessary conditions (Coffman conditions)',
  '',
  'All four must hold simultaneously for deadlock to be possible — breaking any *one* of them prevents deadlock entirely:',
  '',
  '1. **Mutual exclusion** — at least one resource must be held in a non-shareable mode (only one process can use it at a time).',
  '2. **Hold and wait** — a process holding at least one resource is waiting to acquire additional resources held by others.',
  "3. **No preemption** — a resource can only be released voluntarily by the process holding it; it can't be forcibly taken away.",
  '4. **Circular wait** — there exists a cycle of processes P1 → P2 → ... → Pn → P1, where each is waiting on a resource held by the next.',
  '',
  '## Classic example',
  '',
  '```text',
  'Process A holds Lock1, wants Lock2',
  'Process B holds Lock2, wants Lock1',
  '-> neither can ever proceed. Circular wait with only 2 processes.',
  '```',
  '',
  '## Prevention strategies (break one condition)',
  '',
  '- [x] **Attack circular wait** — impose a global total ordering on resources; every process must acquire locks in the same order (e.g. always Lock1 before Lock2). This is the most common real-world fix because it is cheap and does not need runtime detection.',
  '- [x] **Attack hold-and-wait** — require a process to request *all* the resources it will need up front, atomically, before starting. Simple but kills concurrency and wastes resources held just in case.',
  '- [ ] **Attack no-preemption** — allow the OS to forcibly take a resource from a process (roll it back), as database engines do when they pick a deadlock victim transaction to abort.',
  '- [ ] **Attack mutual exclusion** — not generally practical; some resources (a printer, a write lock) are inherently exclusive by nature.',
  '',
  '## Deadlock avoidance vs prevention',
  '',
  "**Prevention** structurally rules deadlock out (e.g. lock ordering). **Avoidance** allows all four conditions to potentially hold, but makes runtime decisions to dodge unsafe states — the classic example is the **Banker's Algorithm**, which only grants a resource request if the resulting state is still 'safe' (there exists *some* order in which all processes could still finish). It requires processes to declare their maximum resource needs up front, which is often unrealistic in practice.",
  '',
  '## Detection and recovery',
  '',
  'Instead of preventing or avoiding deadlock, some systems just let it happen and detect it — periodically build a resource-allocation graph and check for cycles. On detection, recovery options are: kill one or more processes in the cycle (often chosen by lowest priority or least work-done-so-far to minimise waste), or preempt resources from a victim and roll it back.',
  '',
  '## Why real systems mostly use lock ordering',
  '',
  "Detection algorithms cost CPU time to run and recovery is disruptive (lost work). Avoidance (Banker's Algorithm) needs advance knowledge that's rarely available. In practice, a documented, enforced lock-acquisition order across the whole codebase is by far the cheapest and most common real-world defence — it costs nothing at runtime and just requires discipline (or a linter) at development time.",
);

const solidMarkdown = L(
  '# SOLID Principles',
  '',
  'SOLID is five object-oriented design principles aimed at making code easier to extend and maintain without touching things that already work. See also [[Design Patterns in Practice]] — most classic patterns are really just SOLID applied to a specific recurring problem shape.',
  '',
  '## Single Responsibility Principle (SRP)',
  '',
  'A class should have only one reason to change. A `Report` class that both calculates totals *and* formats output *and* saves to disk has three reasons to change — a formatting tweak now risks breaking the calculation logic too, and every change requires re-testing all three concerns.',
  '',
  '```ts',
  '// Violates SRP -- one class, three responsibilities',
  'class Report {',
  '  calculateTotal(items: Item[]): number { /* ... */ return 0; }',
  "  formatAsHtml(total: number): string { /* ... */ return ''; }",
  '  saveToDisk(html: string): void { /* ... */ }',
  '}',
  '// Split: ReportCalculator, ReportFormatter, ReportSaver -- each with one job',
  '```',
  '',
  '## Open/Closed Principle (OCP)',
  '',
  'Software entities should be open for extension but closed for modification. Instead of an ever-growing `if/else` chain for every new discount type, define a `DiscountStrategy` interface and add new discount classes — the code that *uses* discounts never needs to change when a new discount type is added.',
  '',
  '## Liskov Substitution Principle (LSP)',
  '',
  "A subclass must be usable anywhere its parent class is expected, without breaking correctness. The textbook violation: `Square extends Rectangle` and overrides `setWidth`/`setHeight` to keep both sides equal — this breaks any code that relies on Rectangle's contract that width and height are independent, because setting one silently changes the other.",
  '',
  '## Interface Segregation Principle (ISP)',
  '',
  "Don't force a class to implement methods it doesn't need. A fat `Worker` interface with `work()` *and* `eat()` forces a `RobotWorker` to implement a meaningless `eat()`. Split into `Workable` and `Eatable` — implement only what applies.",
  '',
  '## Dependency Inversion Principle (DIP)',
  '',
  "High-level modules shouldn't depend on low-level modules directly — both should depend on abstractions. A `NotificationService` that directly `new`s up a `SmtpEmailSender` is locked to email forever; depending on a `MessageSender` interface instead means swapping in SMS or push notifications requires zero changes to `NotificationService` itself.",
  '',
  '## Why this matters beyond the exam',
  '',
  '- [x] SRP and ISP keep changes *local* — a bug fix or feature should not ripple through unrelated code.',
  '- [x] OCP and DIP are what actually make unit testing practical — swap a real dependency for a test double through the same interface the production code already depends on.',
  '- [ ] LSP violations are the sneakiest — they compile fine and only break at runtime, often in code far away from where the subclass was defined.',
  '',
  '## Quick self-test',
  '',
  "> If adding a new payment method (PayPal, alongside existing card payments) requires editing an existing `PaymentProcessor.process()` switch statement, which principle is violated? — **OCP**: the class isn't closed for modification, every new payment type means editing existing, already-tested code.",
);

const designPatternsMarkdown = L(
  '# Design Patterns in Practice',
  '',
  'Design patterns are named, reusable solutions to recurring design problems — a shared vocabulary more than a rulebook. The Gang of Four split them into three families: **Creational**, **Structural**, **Behavioural**. Every pattern here is an application of [[SOLID Principles]] to a specific shape of problem.',
  '',
  '## Creational: Factory Method',
  '',
  'Delegates object creation to a subclass instead of calling `new` directly, so the calling code depends only on an abstract product type — a direct application of the Dependency Inversion Principle.',
  '',
  '```ts',
  'interface Notifier { send(msg: string): void; }',
  'class EmailNotifier implements Notifier { send(msg: string) { /* ... */ } }',
  'class SmsNotifier implements Notifier { send(msg: string) { /* ... */ } }',
  '',
  'abstract class NotifierFactory {',
  '  abstract create(): Notifier;',
  '}',
  'class EmailNotifierFactory extends NotifierFactory {',
  '  create() { return new EmailNotifier(); }',
  '}',
  '```',
  '',
  '## Structural: Adapter',
  '',
  'Wraps an incompatible interface so existing client code can use it unchanged. Classic use: a third-party payment library exposes `chargeCard(amount, token)`, but your codebase expects a `PaymentGateway.pay(order)` interface — write a thin `LegacyPaymentAdapter` that implements `PaymentGateway` and translates the call internally.',
  '',
  '## Structural: Decorator',
  '',
  'Adds behaviour to an individual object at runtime by wrapping it, without touching the original class or affecting other instances — e.g. wrapping a `DataSource` with `EncryptedDataSource`, then with `CompressedDataSource`, stacking behaviour like layers rather than needing a combinatorial explosion of subclasses (`EncryptedCompressedDataSource`, `CompressedEncryptedDataSource`, ...).',
  '',
  '## Behavioural: Observer',
  '',
  'Lets an object (the **subject**) notify a list of dependents (**observers**) automatically whenever its state changes, without the subject needing to know anything concrete about them.',
  '',
  '```ts',
  'interface Observer { update(temp: number): void; }',
  '',
  'class WeatherStation {',
  '  private observers: Observer[] = [];',
  '  subscribe(o: Observer) { this.observers.push(o); }',
  '  setTemperature(temp: number) {',
  '    for (const o of this.observers) o.update(temp);',
  '  }',
  '}',
  '```',
  '',
  "This is the foundation almost every UI framework's reactivity and every pub/sub event system is built on.",
  '',
  '## Behavioural: Strategy',
  '',
  'Encapsulates an interchangeable family of algorithms behind a common interface, selected at runtime — this is exactly the `DiscountStrategy` example from the Open/Closed Principle note. The client holds a reference to the interface and never branches on which algorithm to use.',
  '',
  '## When patterns become an anti-pattern',
  '',
  'Applying a pattern where the problem does not call for it adds indirection for no payoff — a single `EmailNotifier` implementation will probably never need a Factory around it. Patterns solve *change* and *variation*; if there is genuinely only ever going to be one implementation, the interface and factory are pure ceremony. Recognising when **not** to apply a pattern is as much a skill as knowing the patterns themselves.',
  '',
  '## Related',
  '',
  'See [[The Testing Pyramid]] for why DIP/Strategy-shaped code (dependencies behind interfaces) is specifically what makes a codebase easy to unit test — swapping a real `Notifier` for a fake one in a test is trivial when the code already depends on the `Notifier` interface rather than a concrete class.',
);

const testingPyramidMarkdown = L(
  '# The Testing Pyramid',
  '',
  'The testing pyramid is a heuristic for how a healthy test suite\'s effort should be distributed across levels: **lots** of fast unit tests, **fewer** integration tests, and a **small** number of slow end-to-end tests at the top.',
  '',
  '## The three layers',
  '',
  '| Layer | Scope | Speed | Typical count |',
  '|---|---|---|---|',
  '| Unit | One function/class in isolation | Milliseconds | Hundreds-thousands |',
  '| Integration | Several components together (e.g. DB + code) | Seconds | Dozens-hundreds |',
  '| End-to-end (E2E) | Whole system, real UI, real network | Seconds-minutes each | A handful |',
  '',
  '## Why the shape matters',
  '',
  'Inverting the pyramid — few unit tests, mostly E2E — is a common and expensive mistake:',
  '',
  '- E2E tests are **slow**, so the whole suite takes forever to run, which means developers run it less often and feedback loops get longer.',
  '- E2E tests are **flaky** — timing issues, network blips, and UI changes break them for reasons unrelated to actual bugs, eroding trust until people start ignoring red builds.',
  '- A failing E2E test tells you *something* broke somewhere in a huge surface area; a failing unit test tells you exactly which function broke, in milliseconds.',
  '',
  '## Unit tests',
  '',
  'Test one unit of behaviour in isolation, with all its dependencies replaced by test doubles (mocks/stubs/fakes) — this is exactly why the Dependency Inversion principle from [[SOLID Principles]] matters so much for testability: if a class depends on a concrete `SmtpEmailSender`, you cannot isolate it without actually sending an email in a test run.',
  '',
  '```ts',
  "test('applies a 10% discount above £100', () => {",
  '  const strategy = new BulkDiscountStrategy();',
  '  expect(strategy.apply(150)).toBe(135);',
  '});',
  '```',
  '',
  '## Integration tests',
  '',
  "Verify that real components work together correctly — e.g. that a repository class actually reads/writes the real database schema correctly, not just that it calls the right mocked methods in the right order. Catches the class of bug unit tests structurally can't: the mock lied about how the real dependency behaves.",
  '',
  '## End-to-end tests',
  '',
  'Drive the whole system exactly as a user would — click through a real UI against a real (or realistic) backend. Essential for catching integration failures across the *whole* stack (wiring, deployment config, real browser behaviour) that no lower layer can see, but expensive enough that they should cover **critical user journeys only**, not every edge case.',
  '',
  '## Practical exam checklist',
  '',
  '- [x] Can explain why a failing E2E test is a worse debugging experience than a failing unit test',
  '- [x] Can explain the mock/stub/fake distinction',
  '- [ ] Can name one concrete bug class each layer catches that the others structurally cannot',
  '',
  '## Related',
  '',
  '[[Agile & Scrum Essentials]] — a fast test suite is what makes short iteration cycles (a sprint, or even a single day of TDD red-green-refactor) actually viable; a slow, flaky suite quietly kills the short-feedback-loop premise the whole agile approach depends on.',
);

const agileMarkdown = L(
  '# Agile & Scrum Essentials',
  '',
  'Agile is a set of values and principles (the Agile Manifesto, 2001) favouring iterative delivery, working software, and responding to change over rigidly following an upfront plan. Scrum is the most widely used **framework** that implements those values with concrete roles, events, and artifacts.',
  '',
  '## The three Scrum roles',
  '',
  '| Role | Responsibility |',
  '|---|---|',
  '| Product Owner | Owns the backlog, decides *what* gets built and in what priority order |',
  '| Scrum Master | Removes blockers, protects the team\'s process, facilitates ceremonies |',
  '| Development Team | Cross-functional, self-organising — decides *how* the work gets done |',
  '',
  '## The Scrum events (ceremonies)',
  '',
  '- [x] **Sprint Planning** — team commits to a set of backlog items for the upcoming sprint (typically 1-4 weeks).',
  '- [x] **Daily Scrum / standup** — ~15 minutes, each member covers: what I did, what I am doing next, any blockers. Not a status report to management — it is the team synchronising with itself.',
  '- [ ] **Sprint Review** — demo the working increment to stakeholders, gather feedback.',
  '- [ ] **Sprint Retrospective** — the team reflects on *how* it worked (process, not product) and agrees on concrete process improvements for next sprint.',
  '',
  '## The artifacts',
  '',
  '- **Product Backlog** — the full, prioritised list of everything that might ever be built, owned by the Product Owner, constantly refined.',
  '- **Sprint Backlog** — the subset pulled into the current sprint, owned by the dev team.',
  '- **Increment** — the sum of all completed backlog items, which must be in a releasable state at the end of every sprint — this is the concrete definition of done work, not nearly done.',
  '',
  '## User stories',
  '',
  "A common format for backlog items: 'As a `<role>`, I want `<goal>`, so that `<benefit>`.' The value is forcing every piece of work to state *who* benefits and *why*, not just *what* to build — it keeps the backlog anchored to actual user value instead of becoming a raw technical task list.",
  '',
  '## Definition of Done',
  '',
  'A shared, explicit checklist the whole team agrees an item must satisfy before it counts as complete — e.g. code reviewed, tests passing (see [[The Testing Pyramid]]), deployed to staging. Without an explicit Definition of Done, done silently means different things to different people, and half-finished work quietly piles up as hidden technical debt.',
  '',
  '## Common anti-patterns',
  '',
  '- **Water-Scrum-Fall** — sprints exist on paper, but requirements are still fixed upfront and nothing actually ships until one big release at the end; none of Agile\'s actual feedback-loop benefit survives.',
  '- **Zombie Scrum** — all the ceremonies happen on schedule, but nobody actually inspects-and-adapts based on them; the retrospective produces no real change sprint after sprint.',
  '- **Story-point gaming** — points get treated as a performance metric instead of a rough relative-sizing tool, which incentivises inflating estimates rather than estimating honestly.',
  '',
  '## Why iterations matter',
  '',
  "Short iterations mean the cost of being wrong about a requirement is capped at one sprint's worth of work, not a whole project's — direct feedback from a real stakeholder every 1-4 weeks catches misunderstandings far earlier than a single upfront specification ever could.",
);

const readingListMarkdown = L(
  '# Reading List — Summer Term',
  '',
  'Books and papers to get through before next term starts. Roughly ordered by priority.',
  '',
  '## Currently reading',
  '',
  '- [ ] *Designing Data-Intensive Applications* — Martin Kleppmann. On the replication chapter, ch. 5. Dense but directly useful after this term\'s databases module ([[Normalisation: 1NF to 3NF]], [[ACID Transactions]]).',
  '- [ ] *Clean Architecture* — Robert C. Martin. Want to see how much overlaps with [[SOLID Principles]] vs how much is genuinely new.',
  '',
  '## Queued',
  '',
  '- [ ] *The Pragmatic Programmer* (20th anniversary edition) — recommended by three different people this term, clearly overdue.',
  '- [ ] *Introduction to Algorithms* (CLRS) — not cover to cover, just the B-tree chapter properly (lecture notes on [[B-Trees and Balanced Search Trees]] moved fast) and the amortised analysis chapter.',
  '- [ ] Paper: "Dynamo: Amazon\'s Highly Available Key-value Store" — keeps getting referenced in distributed systems discussions, should actually read it rather than nod along.',
  '',
  '## Finished this term',
  '',
  '- [x] *A Philosophy of Software Design* — John Ousterhout. Short, opinionated, genuinely changed how I think about function/module boundaries — more useful in practice than I expected going in.',
  '- [x] *The Scrum Guide* (official, free PDF) — read alongside the [[Agile & Scrum Essentials]] lecture, good to have the primary source rather than just the summarised version.',
  '',
  '## Notes to self',
  '',
  '> Stop starting a fourth book before finishing the second one. Cap it at two in progress at once.',
  '',
  'Also: actually take notes *while* reading instead of highlighting and hoping — half of what I "read" last term left zero trace anywhere I can search now.',
  '',
  '## Possible next-term electives influenced by this reading',
  '',
  '- Distributed Systems (the Dynamo paper + DDIA overlap heavily with the module description)',
  '- Advanced Databases, if it covers more than what this term\'s [[SQL Joins Explained]] already did',
);

const flatHuntingMarkdown = L(
  '# Flat Hunting Notes',
  '',
  'Tracking viewings for next year\'s house before the good ones get snapped up. Budget: £550/month max per person, bills split 4 ways.',
  '',
  '## Shortlist comparison',
  '',
  '| Address | Rent (pcm, total) | Bedrooms | Distance to campus | Bills included? |',
  '|---|---|---|---|---|',
  '| Elm Street, No. 14 | £2,100 | 4 | 12 min cycle | No |',
  '| Mill Road flat | £2,300 | 4 | 8 min walk | Yes (capped) |',
  '| Ash Grove house | £1,950 | 4 | 20 min bus | No |',
  '',
  "Mill Road looks best on paper once bills are factored in — the £200/month premium over Elm Street roughly matches what we're paying for gas/electric/water/wifi separately right now, and it's walkable so nobody needs a bike lock replaced again.",
  '',
  '## Viewing checklist',
  '',
  '- [x] Elm Street — viewed Tuesday. Boiler looked old, ask letting agent for service history.',
  '- [x] Mill Road — viewed Thursday. Good natural light, landlord seemed responsive over email already, which is a good sign.',
  '- [ ] Ash Grove — booked for Monday next week.',
  "- [ ] Ask every landlord directly: who's on the tenancy deposit protection scheme, and which one.",
  "- [ ] Check each property against the university's off-campus housing checklist before signing anything.",
  '',
  '## Questions to ask before signing',
  '',
  '1. Is the deposit protected in a government-backed scheme (TDS/DPS/MyDeposits)?',
  '2. What exactly does \'bills included\' cap at — is there an overage charge past a certain usage?',
  '3. Who is responsible for garden/communal area upkeep?',
  "4. Minimum tenancy length, and what's the process/penalty for breaking it early?",
  '',
  '## Flatmates status',
  '',
  "> Me, Priya, and Tom are confirmed. Still need a fourth — Jake said maybe but hasn't committed. Deadline to decide: end of next week, since Mill Road said they're getting other interest.",
  '',
  '## Next actions',
  '',
  '- [ ] Ash Grove viewing Monday',
  '- [ ] Chase Jake for a definite yes/no by Friday',
  '- [ ] If Jake is out, ask in the course group chat for a fourth',
  '- [ ] Re-read Mill Road\'s draft tenancy agreement properly (not just skim it) before the holding deposit is due',
);

// Earlier drafts of the Big-O note, for version history.
const bigODraftV1 = L(
  '# Big-O Notation',
  '',
  'Big-O describes how an algorithm\'s running time grows as input size n grows. Ignore constants, focus on the shape of the curve.',
  '',
  '## Classes so far',
  '',
  '- O(1) constant',
  '- O(n) linear',
  '- O(n^2) quadratic',
);
const bigODraftV2 = L(
  '# Big-O Notation & Complexity Analysis',
  '',
  "Big-O notation describes how an algorithm's running time or space requirement grows as the input size n grows. It captures the worst-case upper bound, ignoring constant factors.",
  '',
  '## Common complexity classes',
  '',
  '| Notation | Name | Example |',
  '|---|---|---|',
  '| O(1) | Constant | Array index lookup |',
  '| O(log n) | Logarithmic | Binary search |',
  '| O(n) | Linear | Single loop |',
  '| O(n log n) | Linearithmic | Merge sort |',
  '| O(n²) | Quadratic | Nested loops |',
  '',
  '## TODO',
  '',
  '- Add a worked binary search example',
  '- Add exam tips section',
);

// ---------------------------------------------------------------------------------
// Seed run
// ---------------------------------------------------------------------------------

/**
 * Everything a brand-new account needs to land somewhere usable: one starter notebook,
 * plus the shared built-in templates.
 *
 * Idempotent. The built-ins are install-wide (user_id NULL, fixed ids, ON CONFLICT DO
 * NOTHING inside `seedBuiltinTemplates`) rather than copied per account — schema.sql
 * defines a NULL user_id as "visible to everyone", and per-user copies would show up
 * twice in the templates list next to the shared rows. The starter notebook is skipped
 * if the account already has one, so a retried signup cannot produce duplicates.
 */
export async function seedNewUser(userId: string): Promise<void> {
  // Signup is the first thing that touches the DB on a cold serverless instance, so do
  // not assume a boot path already migrated. Both calls are memoised no-ops afterwards.
  await migrate();
  await seedBuiltinTemplates();

  const existing = await db
    .prepare('SELECT 1 AS present FROM notebooks WHERE user_id = ? LIMIT 1')
    .get<{ present: number }>(userId);
  if (existing) return;

  await db
    .prepare(
      `INSERT INTO notebooks (id, user_id, name, emoji, color, position, archived, created_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?)`,
    )
    .run(newId(), userId, 'My notes', '📓', '#6366f1', nowIso());
}

// ---------------------------------------------------------------------------------
// Demo vault (CLI only)
// ---------------------------------------------------------------------------------

const DEMO_EMAIL = 'demo@folio.local';

/** Find or create the demo account the CLI vault is seeded into. */
async function ensureDemoUser(): Promise<string> {
  const existing = await db
    .prepare('SELECT id FROM users WHERE lower(email) = ?')
    .get<{ id: string }>(DEMO_EMAIL);
  if (existing) return existing.id;

  const id = newId();
  const { hash, salt } = await hashPassword('folio-demo-password');
  await db
    .prepare(
      `INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, DEMO_EMAIL, 'Demo student', hash, salt, isoAgo(45 * DAY));
  console.log(`[seed] Created demo account ${DEMO_EMAIL} (password: folio-demo-password)`);
  return id;
}

/**
 * Insert the demo vault for `uid`. Every row is stamped with that owner — the vault is
 * one user's notebook set now, not a global singleton, so nothing here may fall back to
 * a "the only user" assumption.
 */
export async function seedDemoVault(uid: string): Promise<void> {
  const notebookIds = new Map<string, string>();
  const noteIds = new Map<string, string>();
  const noteTexts = new Map<string, string>();

  await tx(async (t) => {
    // `t`, never the module-level `db`: `db` draws a different pooled connection and
    // would run outside this transaction.
    if (FORCE) {
      // Scoped to this user — a --force reseed must not wipe other accounts' notebooks.
      // Cascades to notes -> versions/tags/links/flashcards/review_log.
      await t.prepare('DELETE FROM notebooks WHERE user_id = ?').run(uid);
    }

    // --- Notebooks ---------------------------------------------------------------
    const notebookDefs: Array<{ key: string; name: string; emoji: string; color: string }> = [
      { key: 'algo', name: 'Algorithms & Data Structures', emoji: '📗', color: '#4f46e5' },
      { key: 'db', name: 'Databases', emoji: '🗄️', color: '#0891b2' },
      { key: 'os', name: 'Operating Systems', emoji: '⚙️', color: '#b45309' },
      { key: 'se', name: 'Software Engineering', emoji: '🧩', color: '#7c3aed' },
      { key: 'personal', name: 'Personal', emoji: '✨', color: '#db2777' },
    ];
    for (const [i, nb] of notebookDefs.entries()) {
      const id = newId();
      await t.prepare(
        'INSERT INTO notebooks (id, user_id, name, emoji, color, position, archived, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
      ).run(id, uid, nb.name, nb.emoji, nb.color, i, isoAgo(45 * DAY));
      notebookIds.set(nb.key, id);
    }

    // --- Notes ---------------------------------------------------------------------
    interface NoteSeed {
      key: string;
      notebook: string;
      title: string;
      markdown: string;
      tags: string[];
      pinned?: boolean;
      createdAt: string;
      updatedAt: string;
    }

    const noteDefs: NoteSeed[] = [
      { key: 'bigO', notebook: 'algo', title: 'Big-O Notation & Complexity Analysis', markdown: bigOMarkdown, tags: ['week1', 'lecture'], pinned: true, createdAt: isoAgo(41 * DAY), updatedAt: isoAgo(40 * DAY) },
      { key: 'sorting', notebook: 'algo', title: 'Sorting Algorithms Compared', markdown: sortingMarkdown, tags: ['week1', 'lecture'], createdAt: isoAgo(39 * DAY), updatedAt: isoAgo(38 * DAY) },
      { key: 'btrees', notebook: 'algo', title: 'B-Trees and Balanced Search Trees', markdown: bTreesMarkdown, tags: ['week2', 'lecture'], createdAt: isoAgo(34 * DAY), updatedAt: isoAgo(20 * DAY) },
      { key: 'sqlJoins', notebook: 'db', title: 'SQL Joins Explained', markdown: sqlJoinsMarkdown, tags: ['week1', 'lecture'], createdAt: isoAgo(37 * DAY), updatedAt: isoAgo(36 * DAY) },
      { key: 'normalisation', notebook: 'db', title: 'Normalisation: 1NF to 3NF', markdown: normalisationMarkdown, tags: ['week2', 'lecture'], createdAt: isoAgo(30 * DAY), updatedAt: isoAgo(29 * DAY) },
      { key: 'acid', notebook: 'db', title: 'ACID Transactions', markdown: acidMarkdown, tags: ['week3', 'lecture'], createdAt: isoAgo(23 * DAY), updatedAt: isoAgo(22 * DAY) },
      { key: 'cpuScheduling', notebook: 'os', title: 'CPU Scheduling Algorithms', markdown: cpuSchedulingMarkdown, tags: ['week2', 'lecture'], createdAt: isoAgo(28 * DAY), updatedAt: isoAgo(27 * DAY) },
      { key: 'paging', notebook: 'os', title: 'Paging and Virtual Memory', markdown: pagingMarkdown, tags: ['week3', 'lecture'], createdAt: isoAgo(21 * DAY), updatedAt: isoAgo(20 * DAY) },
      { key: 'deadlock', notebook: 'os', title: 'Deadlock: Conditions and Prevention', markdown: deadlockMarkdown, tags: ['week4', 'lab'], pinned: true, createdAt: isoAgo(14 * DAY), updatedAt: isoAgo(13 * DAY) },
      { key: 'solid', notebook: 'se', title: 'SOLID Principles', markdown: solidMarkdown, tags: ['week3', 'lecture'], createdAt: isoAgo(18 * DAY), updatedAt: isoAgo(17 * DAY) },
      { key: 'designPatterns', notebook: 'se', title: 'Design Patterns in Practice', markdown: designPatternsMarkdown, tags: ['week4', 'lecture'], createdAt: isoAgo(11 * DAY), updatedAt: isoAgo(10 * DAY) },
      { key: 'testingPyramid', notebook: 'se', title: 'The Testing Pyramid', markdown: testingPyramidMarkdown, tags: ['week5', 'lecture'], createdAt: isoAgo(7 * DAY), updatedAt: isoAgo(6 * DAY) },
      { key: 'agile', notebook: 'se', title: 'Agile & Scrum Essentials', markdown: agileMarkdown, tags: ['week5', 'lecture'], createdAt: isoAgo(4 * DAY), updatedAt: isoAgo(3 * DAY) },
      { key: 'readingList', notebook: 'personal', title: 'Reading List — Summer Term', markdown: readingListMarkdown, tags: [], pinned: true, createdAt: isoAgo(2 * DAY), updatedAt: isoAgo(1 * DAY) },
      { key: 'flatHunting', notebook: 'personal', title: 'Flat Hunting Notes', markdown: flatHuntingMarkdown, tags: [], createdAt: isoAgo(1 * DAY), updatedAt: isoAgo(3 * HOUR) },
    ];

    // Pre-assign ids and build a title→id map so wikilinks in each note's markdown resolve
    // to real note ids at conversion time (forward references included). This local map is
    // also why the vault does not need links.ts's async resolver — every title it can
    // resolve belongs to this same user by construction.
    const idByTitle = new Map<string, string>();
    for (const def of noteDefs) {
      const id = newId();
      noteIds.set(def.key, id);
      idByTitle.set(def.title.toLowerCase(), id);
    }
    const resolveTitle = (title: string): string | null => idByTitle.get(title.trim().toLowerCase()) ?? null;

    for (const def of noteDefs) {
      const id = noteIds.get(def.key)!;
      // Notes don't repeat their own title as the first body heading — the title field owns it.
      const body = stripLeadingTitleHeading(def.markdown, def.title);
      const contentJson = JSON.stringify(markdownToTipTap(body, resolveTitle));
      const contentText = markdownToPlainText(body);
      await t.prepare(
        `INSERT INTO notes (id, user_id, notebook_id, title, content_json, content_text, pinned, archived, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      ).run(id, uid, notebookIds.get(def.notebook), def.title, contentJson, contentText, def.pinned ? 1 : 0, def.createdAt, def.updatedAt);

      // Postgres has no `INSERT OR IGNORE`; ON CONFLICT DO NOTHING on the (note_id, tag) PK.
      for (const tag of def.tags) {
        await t
          .prepare('INSERT INTO note_tags (note_id, tag) VALUES (?, ?) ON CONFLICT DO NOTHING')
          .run(id, tag);
      }

      noteTexts.set(def.key, contentText);
    }

    // --- Version history (3 versions on the Big-O note) -----------------------------
    const bigOId = noteIds.get('bigO')!;
    const insertVersion = async (markdown: string, cause: string, label: string | null, createdAt: string) => {
      await t.prepare(
        'INSERT INTO note_versions (note_id, title, content_json, cause, label, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        bigOId,
        'Big-O Notation & Complexity Analysis',
        JSON.stringify(markdownToTipTap(markdown)),
        cause,
        label,
        createdAt,
      );
    };
    await insertVersion(bigODraftV1, 'autosave', null, isoAgo(41 * DAY - 1 * HOUR));
    await insertVersion(bigODraftV2, 'autosave', null, isoAgo(40 * DAY + 12 * HOUR));
    await insertVersion(bigOMarkdown, 'manual', 'Before exam prep pass', isoAgo(40 * DAY + 2 * HOUR));

    // --- Flashcards (12 total, 6 due now) --------------------------------------------
    const insertCard = async (noteKey: string, question: string, answer: string, dueAt: string, reps: number, intervalDays: number) => {
      const id = newId();
      await t.prepare(
        `INSERT INTO flashcards (id, user_id, note_id, question, answer, ease, interval_days, reps, lapses, due_at, suspended, created_at)
         VALUES (?, ?, ?, ?, ?, 2.5, ?, ?, 0, ?, 0, ?)`,
      ).run(id, uid, noteIds.get(noteKey), question, answer, intervalDays, reps, dueAt, isoAgo(5 * DAY));
    };

    // Due now (past due_at)
    await insertCard('bigO', 'What is the time complexity of binary search?', 'O(log n) — each comparison halves the remaining search space.', isoAgo(2 * HOUR), 0, 0);
    await insertCard('bigO', "What does O(n²) typically indicate about an algorithm's structure?", 'Nested iteration over the same input, e.g. two nested loops each running n times.', isoAgo(6 * HOUR), 0, 0);
    await insertCard('sorting', 'What is the average-case time complexity of quicksort?', 'O(n log n), degrading to O(n²) worst case with a poor pivot choice.', isoAgo(1 * HOUR), 0, 0);
    await insertCard('btrees', 'What is the minimum degree property of a B-tree of order t?', 'Every node except the root must have at least t-1 keys, and every node can have at most 2t-1 keys.', isoAgo(30 * 60 * 1000), 0, 0);
    await insertCard('normalisation', 'What defines Second Normal Form (2NF)?', 'The table is in 1NF and every non-key attribute is fully functionally dependent on the whole primary key (no partial dependency).', isoAgo(4 * HOUR), 0, 0);
    await insertCard('cpuScheduling', 'What is the main drawback of First-Come-First-Served (FCFS) scheduling?', 'The convoy effect — short jobs can be stuck waiting behind one long job, increasing average waiting time.', isoAgo(10 * HOUR), 0, 0);

    // Due in the future (already reviewed at least once)
    await insertCard('sorting', 'Why is merge sort considered stable?', 'Equal elements retain their relative order because the merge step always takes from the left sub-array first when values are equal.', isoIn(3 * DAY), 1, 1);
    await insertCard('sqlJoins', 'What does an INNER JOIN return?', 'Only the rows that have matching values in both joined tables.', isoIn(1 * DAY), 1, 1);
    await insertCard('acid', "What does the 'I' in ACID stand for and what does it guarantee?", 'Isolation — concurrent transactions produce the same result as if they ran serially.', isoIn(5 * DAY), 2, 4);
    await insertCard('deadlock', 'Name the four necessary conditions for deadlock.', 'Mutual exclusion, hold and wait, no preemption, circular wait.', isoIn(2 * DAY), 1, 1);
    await insertCard('solid', "What does the 'O' in SOLID stand for?", 'Open/Closed Principle — software entities should be open for extension but closed for modification.', isoIn(7 * DAY), 2, 6);
    await insertCard('designPatterns', 'What problem does the Observer pattern solve?', 'It lets an object (subject) notify a list of dependents (observers) automatically when its state changes, without tightly coupling them.', isoIn(4 * DAY), 1, 1);
  });

  // Wikilink resolution runs AFTER the commit: syncLinksForNote opens its own transaction
  // on the pool, so calling it inside the block above would have executed outside that
  // transaction anyway — and its title lookups need every note to be visible.
  for (const [key, id] of noteIds) {
    await syncLinksForNote(uid, id, noteTexts.get(key) ?? '');
  }
}

async function main(): Promise<void> {
  await migrate();
  const uid = await ensureDemoUser();

  const existing = await db
    .prepare('SELECT COUNT(*) as c FROM notebooks WHERE user_id = ?')
    .get<{ c: number }>(uid);
  if ((existing?.c ?? 0) > 0 && !FORCE) {
    console.log('[seed] Demo account already has notebooks — skipping (pass --force to wipe and reseed).');
    return;
  }

  await seedDemoVault(uid);
  await seedBuiltinTemplates();

  const count = async (table: string) =>
    (await db.prepare(`SELECT COUNT(*) as c FROM ${table} WHERE user_id = ?`).get<{ c: number }>(uid))?.c ?? 0;
  // `links` carries no user_id, so it is counted through its from-note instead.
  const links =
    (
      await db
        .prepare('SELECT COUNT(*) as c FROM links l JOIN notes n ON n.id = l.from_note_id WHERE n.user_id = ?')
        .get<{ c: number }>(uid)
    )?.c ?? 0;
  console.log(
    `[seed] Done — ${await count('notebooks')} notebooks, ${await count('notes')} notes, ${links} links, ${await count('flashcards')} flashcards.`,
  );
}

// Only run the demo vault when this file IS the process entry point. routes/auth.ts
// imports `seedNewUser` from here on every boot, and an unguarded call would reseed
// 15 demo notes each time the server started.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error('[seed] failed:', err);
      process.exit(1);
    },
  );
}
