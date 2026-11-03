"""Evals for Life Island's guarded LLM features.

Offline suites (``pytest -m offline``) run the real Cloud Functions code through
small Node shims and the fixtures that ``tools/dump_personas.mjs`` writes from
the built ``functions/lib``. Live suites (``pytest -m live``) call the Anthropic
API with the same prompts npcChat and the planner send, under a hard token
budget, and run only from the ``evals-live`` workflow.
"""
