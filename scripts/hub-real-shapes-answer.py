"""Regenerates src/features/hub/model/fixtures/ash-os-real-shapes-answer.json: what the REAL ashos.hub.Hub answers for
ash-hub-question and ash-hub-answer (branch ash-os-hub-answer), on a temporary ledger built by that repo's own tests.
Never touches Ash's live ledger. The model is down here, so a chosen option or typed answer shows the saved-answer path.

    PYTHONDONTWRITEBYTECODE=1 /opt/homebrew/bin/python3 -B scripts/hub-real-shapes-answer.py > /tmp/shapes-answer.json
"""
import json
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, "/Users/ash/Worktrees/exo-cc-studio-hub-answer")
from tests.hub_fixture import HubEnv, down  # noqa: E402


class Fixture(HubEnv):
    model = staticmethod(down)

    def runTest(self):
        pass


t = Fixture()
t.setUp()
try:
    def make(text, rec="", options=None):
        a = t.ask("vg-game", f"{text} (ask)")
        return t.ash.ask_ash(text, ask_ids=[a], project="vg-game", recommendation=rec, options=options)["question_id"]

    with_options = make("Bastion can use more work. Which part first?", "Do the shield first. It is missing.",
                        ["Shield first", "Combo first (bigger)", "Second weapon set first"])
    no_options = make("Should the old waitlist be archived?", "Park it for later.")
    bare = make("A plain question?")
    t.step()
    out = {
        "question_with_options": t.hub.action("question", {"id": f"q:{with_options}"}),
        "question_no_options": t.hub.action("question", {"id": no_options}),
        "question_bare": t.hub.action("question", {"id": bare}),
        "answer_quick_park": t.hub.action("answer", {"id": no_options, "quick": "park"}),
        "answer_choice_model_down": t.hub.action("answer", {"id": with_options, "choice": 0}),
    }
    t.step()
    out["question_after_held"] = t.hub.action("question", {"id": with_options})
    print(json.dumps(out, indent=1, default=str))
finally:
    t.tearDown()
