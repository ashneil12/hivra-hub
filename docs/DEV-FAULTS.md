# Dev faults (scripted tests only)

Off by default. Nothing in the app arms a fault; only a file a tester writes by hand does.

## Make the next delegated workers fail (scorecard D5)

A worker a Mono delegates really starts and runs; when its turn ends it reports a **failure** with the plain error
"Test fault: this worker was set to fail on purpose for a test (dev-faults/fail-next-workers)." and **no report**:
whatever the worker wrote in its chat never reaches its Lead (since r47; before, its whole report still went through and
the Lead could say the job was done). Its Lead sees a real
failed worker and handles it the way it handles any failure (retry, then report it stuck to Ash OS: one Needs you row
with the reason and "Open <Lead>'s chat"). No keys, folders or settings are touched.

Arm it (count 1-5; 3 for D5):

```sh
D="$HOME/Library/Application Support/com.ash.monocode-hub/dev-faults"
mkdir -p "$D" && printf 'fail-next-workers\n3\n' > "$D/fail-next-workers"
```

Then, in the real app, ask a Lead for a small job it will hand to a worker. Each worker started while the file is armed
takes one fault (the count goes down). At zero the file is removed.

Disarm early: `rm "$D/fail-next-workers"`.

Safety:
- the first line must be exactly `fail-next-workers` and the count 1-5, or the file does nothing (and a bad count is removed);
- an armed file older than 2 hours is ignored and removed, so a forgotten one never breaks real work;
- only delegated workers are affected (never a Mono's own chat or Ash's sessions); a stop stays a stop;
- the app log says `[dev-fault] a delegated worker takes a test failure (N left)` each time.
