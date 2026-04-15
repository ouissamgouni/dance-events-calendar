"""Config endpoints — app info, environment, QA test plans."""

import json

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from backend.api.schemas import AppInfoResponse
from backend.config.loader import get_app_version, get_env_name
from backend.db.database import get_session
from backend.db.models import SiteSetting

router = APIRouter(prefix="/api/config", tags=["config"])


def _load_test_plans(session: Session) -> list[dict]:
    row = session.get(SiteSetting, "qa_test_plans")
    if not row or not row.value:
        return []
    try:
        plans = json.loads(row.value)
        return plans if isinstance(plans, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


@router.get("/info", response_model=AppInfoResponse)
def get_app_info(session: Session = Depends(get_session)):
    plans = _load_test_plans(session)
    qa_scenarios = [
        p["scenario"] for p in plans if isinstance(p, dict) and "scenario" in p
    ]
    return AppInfoResponse(
        environment=get_env_name(),
        backend_version=get_app_version(),
        qa_scenarios=qa_scenarios,
    )


@router.get("/test-plan")
def get_test_plan(scenario: str, session: Session = Depends(get_session)):
    if not scenario:
        raise HTTPException(status_code=400, detail="scenario parameter required")
    plans = _load_test_plans(session)
    for plan in plans:
        if isinstance(plan, dict) and plan.get("scenario") == scenario:
            return plan
    raise HTTPException(
        status_code=404, detail=f"No test plan found for scenario '{scenario}'"
    )
