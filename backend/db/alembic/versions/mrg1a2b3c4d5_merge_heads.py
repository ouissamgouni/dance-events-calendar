"""merge event mutes and suggested events heads

Revision ID: mrg1a2b3c4d5
Revises: evm1a2b3c4d5, se7a8b9c0d1e
Create Date: 2026-08-12

Merge the two divergent heads ``evm1a2b3c4d5`` (add_user_event_mutes) and
``se7a8b9c0d1e`` (add_user_suggested_events_enabled) into a single head so
migrations can run to ``head`` again.
"""

from typing import Sequence, Union

revision: str = "mrg1a2b3c4d5"
down_revision: Union[str, Sequence[str], None] = ("evm1a2b3c4d5", "se7a8b9c0d1e")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
