"""Regenerates src/features/hub/model/fixtures/ash-os-real-shapes-jobs.json: what the REAL ashos.hub.Hub answers for
jobs, the job options sheet, a given-up job's Need, the `older` group and `need-seen`.

Runs the Ash OS code (read only, from the ash-os-hub-jobs worktree) on a temporary ledger built by that repo's own
tests (tests/jobs_fixture.py). It never touches Ash's live ledger. Python 3.14 (Homebrew).

    PYTHONDONTWRITEBYTECODE=1 /opt/homebrew/bin/python3 -B scripts/hub-real-shapes-jobs.py > /tmp/shapes-jobs.json
"""
import json
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, "/Users/ash/Worktrees/exo-cc-studio-hub-jobs")
from tests.hub_fixture import down  # noqa: E402
from tests.jobs_fixture import JobsEnv  # noqa: E402


class Fixture(JobsEnv):
    model = staticmethod(down)

    def runTest(self):
        pass


t = Fixture()
t.setUp()
try:
    out = {}
    t.hub.needs()
    t.step()
    mono = t.give_lead("hivra")

    # an ask that failed, was sent to the Lead, and the Lead gave up: a red Needs row
    a = t.ask("hivra", "Fix the save bug", status="working")
    ref = f"ask:{a}"
    t.ledger.set_meta("runner_tried:hivra", [a])
    t.see(ref=ref, title="Fixing the save bug")
    t.ash.ask_ash('The runner worked on "Fix the save bug" for Hivra but ran out of time. What should happen next?',
                  ask_ids=[a], project="hivra", origin="failure", recommendation="say go")
    t.see(ref=ref, state="stuck", reason="It ran out of time before it finished.", signature="q1", tried=["the runner's own attempt"])
    gave_up = t.job(ref)["id"]
    t.lead_call(mono, "ack", job_id=gave_up)
    t.lead_call(mono, "gave_up", job_id=gave_up, tried=["splitting the job", "a different worker"])

    # one job each of working, checking, stuck (sent to the Lead, "got it" said), done, parked
    t.see(ref="ask:a_working", project="hivra", title="Writing the welcome emails", state="working")
    t.see(ref="ask:a_checking", project="hivra", title="Checking the signup form", state="checking")
    t.see(ref="ask:a_stuck", project="hivra", title="Moving the nightly backup", state="working")
    t.see(ref="ask:a_stuck", project="hivra", title="Moving the nightly backup", state="stuck", reason="The disk was full twice.", signature="s9", tried=["a second run"])
    sent = t.job("ask:a_stuck")["id"]
    t.lead_call(mono, "ack", job_id=sent)
    t.see(ref="ask:a_nolead", project="nibbii", title="Tidying the sound files", state="working")
    t.see(ref="ask:a_nolead", project="nibbii", title="Tidying the sound files", state="stuck", reason="No sound card in the test box.", signature="n1")
    t.see(ref="ask:a_done", project="hivra", title="Fixing the footer link", state="working")
    t.see(ref="ask:a_done", project="hivra", title="Fixing the footer link", state="done")
    t.step()

    out["jobs"] = t.hub.action("jobs", {})
    out["jobs_hivra"] = t.hub.action("jobs", {"project": "hivra"})
    out["needs_with_gave_up_job"] = t.hub.needs("hivra")
    out["job_options"] = t.hub.action("job-options", {"job_id": gave_up})

    # a critical finished ask (Looks right) and an older (recovered) question
    c = t.ask("nibbii", "Ship the notch pet", status="done")
    t.ledger.update_ask(c, critical=1, evidence="tests passed")
    old_ask = t.ledger.add_ask("vg-game", "task", "Old thing", "old thing", "import_old", [1], "discuss")
    t.ash.ask_ash("Old question from an old chat?", ask_ids=[old_ask], project="vg-game", origin="triage")
    t.question("vg-game", "Fresh question?", rec="Yes.")
    t.step()
    needs = t.hub.needs()
    out["needs_with_older"] = needs
    looks = next(r for e in needs["projects"] for r in e["shown"] + e["later"] if r["id"].startswith("s:"))
    out["need_seen"] = t.hub.action("need-seen", {"id": looks["id"]})

    # Ash's choices on the given-up job
    out["job_act_pause"] = t.hub.action("job-act", {"job_id": gave_up, "option": "pause"})
    out["jobs_after"] = t.hub.action("jobs", {})
    print(json.dumps(out, indent=1, default=str))
finally:
    t.tearDown()
