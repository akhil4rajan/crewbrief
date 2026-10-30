"""Safety rules that live in code, not prompts.

* Form schema validation (every patch result is re-validated against ``Form``)
* Hazard and control code mapping (codes must exist in the library, or be ``*-CUSTOM-*``
  from a human)
* A hazard is never marked ``not_present`` just because nobody mentioned it
* AI never overwrites a value a human set
* AI-filled values must cite transcript evidence (task-typical suggestions excepted)
* A high-risk hazard requires at least one isolation or engineering control (or better)
* Sign-off permissions
"""

from .engine import (
    RuleViolation,
    apply_patch,
    apply_patches,
    can_sign_off,
    evaluate_draft,
    is_crew_lead,
    validate_patch,
)

__all__ = ["RuleViolation", "apply_patch", "apply_patches", "can_sign_off", "evaluate_draft", "is_crew_lead",
           "validate_patch"]
