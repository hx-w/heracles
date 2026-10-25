"""Validated user context, read-only data requests and structured coach replies."""
from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid')


ShortText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]



class Profile(StrictModel):
    goal: str = Field(max_length=1500)
    target_date: str | None
    weekly_days: int = Field(ge=1, le=6)
    experience: str = Field(max_length=500)
    notes: str = Field(max_length=2000)

    @model_validator(mode='after')
    def valid_target(self):
        if self.target_date:
            date.fromisoformat(self.target_date)
        return self


class ToolRequest(StrictModel):
    action: Literal['refresh_data', 'friends_feed', 'activity_details', 'health_details', 'workout_details']
    activity_id: str | None = None
    workout_id: str | None = None
    date: str | None = None
    source: str | None = None
    metrics: list[ShortText] | None = Field(default=None, min_length=1, max_length=6)
    start_at: str | None = None
    end_at: str | None = None

    @model_validator(mode='after')
    def valid_target(self):
        if self.action == 'activity_details' and (
            not self.activity_id or not self.activity_id.isdigit() or int(self.activity_id) <= 0
        ):
            raise ValueError('运动详情查询必须提供有效的 activity_id')
        if self.action == 'workout_details' and not self.workout_id:
            raise ValueError('课程详情查询必须提供同步计划中的 workout_id')
        if self.date:
            date.fromisoformat(self.date)
        for value in (self.start_at, self.end_at):
            if value and datetime.fromisoformat(value).tzinfo is None:
                raise ValueError('运动查询时间必须带时区')
        if self.start_at and self.end_at and datetime.fromisoformat(self.start_at) > datetime.fromisoformat(self.end_at):
            raise ValueError('运动查询开始时间不能晚于结束时间')
        return self


class ReplySection(StrictModel):
    title: ShortText = Field(max_length=50)
    items: list[Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1200)]] = Field(min_length=1, max_length=6)


MetricKey = Literal['resting_hr', 'sleep_hours', 'sleep_score', 'hrv', 'readiness', 'recovery_hours', 'stress', 'acute_load', 'respiration', 'spo2', 'steps', 'body_battery_peak']


class VisualSelection(StrictModel):
    kind: Literal['trend', 'table']
    title: ShortText = Field(max_length=60)
    metrics: list[MetricKey] = Field(min_length=1, max_length=6)


class IllustrationSelection(StrictModel):
    title: ShortText = Field(max_length=60)
    subject: ShortText = Field(max_length=2000)
    caption: ShortText = Field(max_length=300)


class CheckIn(StrictModel):
    fatigue: int = Field(ge=1, le=5)
    soreness: Literal['none', 'mild', 'pain']
    available_minutes: int = Field(ge=5, le=240)
    notes: str = Field(default='', max_length=500)


class TrainingStep(StrictModel):
    phase: Literal['warmup', 'work', 'recovery', 'cooldown']
    title: ShortText = Field(max_length=80)
    duration_seconds: int | None = Field(default=None, ge=10, le=14400)
    distance_meters: int | None = Field(default=None, ge=10, le=50000)
    repeat: int = Field(default=1, ge=1, le=30)
    target: ShortText = Field(max_length=200)
    instructions: ShortText = Field(max_length=500)

    @model_validator(mode='after')
    def one_end_condition(self):
        if (self.duration_seconds is None) == (self.distance_meters is None):
            raise ValueError('每个训练步骤必须指定时间或距离，且只能指定一种')
        return self


class ProposedSession(StrictModel):
    date: str
    base_workout_id: str | None = None
    title: ShortText = Field(max_length=100)
    kind: Literal['rest', 'running', 'cycling', 'strength', 'other']
    reason: ShortText = Field(max_length=500)
    steps: list[TrainingStep] = Field(default_factory=list, max_length=20)
    stop_conditions: ShortText = Field(max_length=500)

    @model_validator(mode='after')
    def valid_session(self):
        date.fromisoformat(self.date)
        if self.kind == 'rest' and self.steps:
            raise ValueError('休息日不能包含训练步骤')
        if self.kind != 'rest' and not self.steps:
            raise ValueError('训练必须包含详细步骤')
        return self


class TrainingProposal(StrictModel):
    title: ShortText = Field(max_length=100)
    rationale: ShortText = Field(max_length=800)
    sessions: list[ProposedSession] = Field(min_length=1, max_length=14)


class CoachReply(StrictModel):
    summary: ShortText = Field(max_length=400)
    sections: list[ReplySection] = Field(max_length=4)
    profile_update: Profile | None = None
    tool_requests: list[ToolRequest] = Field(max_length=3)
    visuals: list[VisualSelection] = Field(default_factory=list, max_length=3)
    illustration: IllustrationSelection | None = None
    proposal: TrainingProposal | None = None

    @model_validator(mode='after')
    def bounded_reply(self):
        size = len(self.summary) + sum(len(s.title) + sum(map(len, s.items)) for s in self.sections) + sum(len(v.title) for v in self.visuals)
        if size > 2600:
            raise ValueError('教练回复过长，请保留结论与必要依据')
        metrics = [key for visual in self.visuals for key in visual.metrics]
        if len(metrics) != len(set(metrics)):
            raise ValueError('同一身体指标只能出现一次')
        if self.tool_requests and self.profile_update is not None:
            raise ValueError('查询回合不能同时修改个人资料')
        if self.tool_requests and self.proposal is not None:
            raise ValueError('查询回合不能同时提交训练方案')
        return self
