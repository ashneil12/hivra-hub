"""Regenerates src/features/hub/model/fixtures/ash-os-real-shapes.json: what the REAL ashos.hub.Hub answers.

Runs the Ash OS hub code (read only, from the ash-os-hub-core worktree) on a temporary ledger, registry and memory built
by that repo's own tests/hub_fixture.py. It never touches Ash's live ledger. Needs Python 3.14 (Homebrew).

    PYTHONDONTWRITEBYTECODE=1 /opt/homebrew/bin/python3 -B scripts/hub-real-shapes.py > /tmp/shapes.json
"""
import json
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, "/Users/ash/Worktrees/exo-cc-studio-hub-core")
from tests.hub_fixture import HubEnv, down  # noqa: E402


class Fixture(HubEnv):
    model = staticmethod(down)

    def runTest(self):
        pass


t = Fixture()
t.setUp()
try:
    for i in range(7):
        t.question("vg-game", f"Question number {i}?", rec="Yes.")
        t.step(0.01)
    q = t.question("hivra", "Pick the waitlist headline?", rec="A")
    t.gate("exo", "card1", "M1 Playtest: dodge (Ash plays)")
    t.step()
    t.hub.active()  # a first visit
    t.clock.advance(3600)
    t.hub.active()  # a return after a gap: opens a new visit
    out = {"projects": t.hub.projects()}
    t.ledger.answer_question(q, "settled in chat")
    t.step()
    out["needs"] = t.hub.needs()
    a = t.ask("hivra", "Send the launch email", status="done")
    t.ledger.update_ask(a, evidence="sent")
    t.step()
    out["since"] = t.hub.since(wait=0)
    out["active"] = t.hub.active()
    out["events"] = t.hub.events(0)
    t.hub.add_mono_project("chief-of-staff", "hivra")
    t.hub.add_mono_project("hivra-lead", "hivra", "lead")
    out["mono_projects"] = t.hub.mono_projects()
    print(json.dumps(out, indent=1, default=str))
finally:
    t.tearDown()
