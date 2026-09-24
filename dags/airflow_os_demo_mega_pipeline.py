"""A deliberately enormous pipeline, built so Paint has something worth painting.

Eighty-eight tasks in ten layers: sensors, extracts, validators, a dynamically
mapped shard transform, an enrichment step that always fails on purpose, a
branch that always sends traffic down one of two publish feeds, a trio of
human-in-the-loop gates before publish, and a final join that closes the run
out regardless of what broke upstream. A few edges skip a layer, just to
tangle the picture further.

Every colour in Paint's colour box shows up on a single run of this dag:
success (green), failed (red, the fraud-scoring step), upstream_failed
(dithered red, its one strict-trigger-rule descendant), skipped (olive, the
branch's untaken feed), and running/queued while it's in flight. The mapped
transform draws as the stacked-frames box Paint uses for dynamic task
mapping. The three HITL gates park the run: answer them from Human Input
Required on the desktop, or leave them for the tray badge.

It is also the load the Performance tab was written for. Each task holds its
pool slot for a few seconds rather than returning instantly, and the layers are
assigned to the narrow pools the demo seeds -- four Spark slots, two GPU slots,
three rate-limited API slots. So a run puts real numbers on both graphs: CPU is
running slots against ``core.parallelism``, Memory is occupied pool slots, and
tasks genuinely queue waiting for a slot rather than sailing through.

Trigger it from Run… — it is not scheduled, and it is not meant to be useful.
"""

from __future__ import annotations

import time
from datetime import timedelta

from airflow.providers.standard.operators.hitl import (
    ApprovalOperator,
    HITLEntryOperator,
    HITLOperator,
)
from airflow.sdk import Param, dag, task

SHARDS = list(range(8))

#: How long a task holds its pool slot. Long enough that the Performance tab has
#: something to draw and Paint catches tasks mid-flight with marching ants; short
#: enough that the whole run still finishes while you are watching it.
PACE_SECONDS = 6

#: Layers are assigned to the pools the demo seeds, smallest where the work would
#: really be scarcest. The narrow ones are the point: with four Spark slots and a
#: dozen transforms wanting them, tasks queue, and Memory means something.
POOLS = {
    "intake": "api_rate_limited",   # 3 slots
    "extract": "warehouse_pool",    # 8 slots
    "validate": "snowflake_etl",    # 6 slots
    "transform": "spark_cluster",   # 4 slots
    "enrich": "ml_gpu",             # 2 slots
    "publish": "notifications",     # 10 slots
}


@dag(
    dag_id="airflow_os_demo_mega_pipeline",
    schedule=None,
    catchup=False,
    is_paused_upon_creation=False,
    tags=["airflow-os", "demo", "chaos"],
    doc_md=__doc__,
)
def airflow_os_demo_mega_pipeline():
    @task
    def process(*signals: int) -> int:
        """Generic filler work: fold whatever upstream sent and pass a number on."""
        total = sum(value for value in signals if isinstance(value, (int, float)))
        print(f"processed {len(signals)} upstream signal(s), running total {total}")
        # Holds the pool slot, so the desktop has a running process to show.
        time.sleep(PACE_SECONDS)
        return total + 1

    @task
    def process_and_fail(*signals: int) -> int:
        """Same as ``process``, except the fraud model is missing a shard checksum."""
        total = sum(value for value in signals if isinstance(value, (int, float)))
        print(f"processed {len(signals)} upstream signal(s), running total {total}")
        raise ValueError("enrich_fraud_scores: corrupt shard checksum (expected 7, got 4)")

    @task
    def transform_shard(base: int, shard: int) -> int:
        print(f"transforming shard {shard} against base {base}")
        time.sleep(PACE_SECONDS)
        return base + shard

    @task
    def reduce_shards(parts: list[int]) -> int:
        total = sum(parts)
        print(f"reduced {len(parts)} shard result(s) to {total}")
        return total

    @task.branch
    def route_scoring_result(*signals: int) -> str:
        """Always ships the dashboard feed; the alert feed sits this run out."""
        print(f"scoring signals: {signals}")
        return "publish_dashboard_feed"

    def fan_in(prev: list, index: int, count: int) -> list:
        """A deterministic, tangled pick of ``count`` results from the prior layer."""
        n = len(prev)
        if n == 0:
            return []
        start = (index * 2) % n
        return [prev[(start + j) % n] for j in range(min(count, n))]

    # ---- layer 0: sensors, nothing upstream -----------------------------------
    sensor_names = [
        "intake_orders",
        "intake_users",
        "intake_events",
        "intake_payments",
        "intake_inventory",
        "intake_logs",
    ]
    layer0 = [process.override(task_id=name, pool=POOLS["intake"])() for name in sensor_names]

    # ---- layer 1: extract ------------------------------------------------------
    layer1 = [
        process.override(task_id=f"extract_feed_{i:02d}", pool=POOLS["extract"])(
            *fan_in(layer0, i, (i % 3) + 1)
        )
        for i in range(10)
    ]

    # ---- layer 2: validate ------------------------------------------------------
    layer2 = [
        process.override(task_id=f"validate_batch_{i:02d}", pool=POOLS["validate"])(
            *fan_in(layer1, i, (i % 3) + 1)
        )
        for i in range(12)
    ]

    # ---- layer 3: transform, including one dynamically mapped shard step ------
    mapped = (
        transform_shard.override(task_id="transform_shard", pool=POOLS["transform"])
        .partial(base=layer2[0])
        .expand(shard=SHARDS)
    )
    reduced = reduce_shards(mapped)
    layer3_filler = [
        process.override(task_id=f"transform_stream_{i:02d}", pool=POOLS["transform"])(
            *fan_in(layer2, i, (i % 3) + 1)
        )
        for i in range(12)
    ]
    # a couple of edges reach back two layers, just to tangle the picture
    layer1[3] >> layer3_filler[2]
    layer1[7] >> layer3_filler[9]
    layer3 = [reduced, *layer3_filler]

    # ---- layer 4: enrich, including the fraud step that always fails ----------
    failing = process_and_fail.override(task_id="enrich_fraud_scores", pool=POOLS["enrich"])(
        *fan_in(layer3, 0, 2)
    )
    layer4_filler = [
        process.override(task_id=f"enrich_signal_{i:02d}", pool=POOLS["enrich"])(
            *fan_in(layer3, i, (i % 3) + 1)
        )
        for i in range(13)
    ]
    # (the enrich layer as a whole is never referenced again; layer4_filler is)

    # ---- layer 5: aggregate, including the one strict upstream_failed leaf ----
    # demonstrates upstream_failed: default trigger rule, real data dependency on `failing`
    process.override(task_id="load_fraud_warehouse")(failing)
    layer5_filler = []
    for i in range(11):
        inputs = fan_in(layer4_filler, i, (i % 3) + 1)
        instance = process.override(task_id=f"aggregate_window_{i:02d}", trigger_rule="all_done")(*inputs)
        if i % 4 == 0:
            # structural only: joins the failed task without pulling its (missing) XCom
            failing >> instance
        layer5_filler.append(instance)
    layer5 = layer5_filler

    # ---- layer 6: score, including the branch ----------------------------------
    branch = route_scoring_result.override(task_id="route_scoring_result")(*fan_in(layer5, 0, 3))
    layer6_filler = [
        process.override(task_id=f"score_model_{i:02d}")(*fan_in(layer5, i, (i % 3) + 1))
        for i in range(7)
    ]
    layer3_filler[4] >> layer6_filler[1]
    layer6 = layer6_filler

    # ---- layer 6.5: three human-in-the-loop gates before anything ships -------
    release_gate = ApprovalOperator(
        task_id="mega_pipeline_release_gate",
        subject="Ship the mega pipeline's output?",
        body="Scoring finished. Approving publishes the partner and audit feeds.",
        defaults="Reject",
        response_timeout=timedelta(minutes=55),
    )
    region_gate = HITLOperator(
        task_id="mega_pipeline_region_gate",
        subject="Which regions get this run's ML features?",
        body="Tick every region to publish to. eu-central-1 is pre-selected as the canary.",
        options=["eu-central-1", "eu-west-1", "us-east-1", "ap-southeast-2"],
        defaults=["eu-central-1"],
        multiple=True,
        response_timeout=timedelta(minutes=55),
    )
    rollout_gate = HITLEntryOperator(
        task_id="mega_pipeline_rollout_gate",
        subject="Data catalog publish parameters",
        body="Retention and owning team for this run's catalog entry.",
        params={
            "retention_days": Param(90, type="integer", minimum=1, maximum=3650),
            "owning_team": Param("data-platform", type="string"),
            "pii_reviewed": Param(False, type="boolean"),
        },
        response_timeout=timedelta(minutes=55),
    )
    layer6[0] >> release_gate
    layer6[1] >> region_gate
    layer6[2] >> rollout_gate

    # ---- layer 7: publish, two of which are branch-gated -----------------------
    publish_dashboard_feed = process.override(task_id="publish_dashboard_feed", pool=POOLS["publish"])()
    publish_alert_feed = process.override(task_id="publish_alert_feed", pool=POOLS["publish"])()
    branch >> [publish_dashboard_feed, publish_alert_feed]

    publish_partner_feed = process.override(task_id="publish_partner_feed", pool=POOLS["publish"])(
        *fan_in(layer6, 0, 3)
    )
    publish_audit_trail = process.override(task_id="publish_audit_trail", pool=POOLS["publish"])(
        *fan_in(layer6, 1, 3)
    )
    publish_ml_features = process.override(task_id="publish_ml_features", pool=POOLS["publish"])(
        *fan_in(layer6, 2, 3)
    )
    publish_data_catalog = process.override(task_id="publish_data_catalog", pool=POOLS["publish"])(
        *fan_in(layer6, 3, 3)
    )
    release_gate >> [publish_partner_feed, publish_audit_trail]
    region_gate >> publish_ml_features
    rollout_gate >> publish_data_catalog
    layer7 = [
        publish_dashboard_feed,
        publish_alert_feed,
        publish_partner_feed,
        publish_audit_trail,
        publish_ml_features,
        publish_data_catalog,
    ]

    # ---- layer 8: final join, closes the run regardless of what broke ---------
    for name in ("notify_ops", "archive_run", "close_ticket"):
        process.override(task_id=name, trigger_rule="none_failed_min_one_success")(*layer7)


airflow_os_demo_mega_pipeline()
