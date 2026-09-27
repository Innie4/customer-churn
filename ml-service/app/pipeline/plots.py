"""Server-side chart rendering.

Matplotlib runs on the Agg backend so charts render without a display. Output
is written to the artifact tree and referenced by path, so the application
never has to reimplement plotting in the browser.

The palette is deliberately restrained. Colour encodes meaning: one hue for
"increases risk", another for "reduces risk", neutral for ordinary content.
"""

from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

# Restrained, meaning-carrying palette. Matches the application theme.
INK = "#111827"
MUTED = "#6b7280"
GRID = "#e5e7eb"
RISK = "#b91c1c"       # restrained red - increases risk
PROTECT = "#047857"     # calm green - reduces risk
NEUTRAL = "#94a3b8"
ACCENT = "#4338ca"      # indigo - informational emphasis
WARN = "#b45309"        # amber - elevated

_BASE_STYLE = {
    "figure.facecolor": "white",
    "axes.facecolor": "white",
    "axes.edgecolor": GRID,
    "axes.labelcolor": INK,
    "text.color": INK,
    "xtick.color": MUTED,
    "ytick.color": MUTED,
    "axes.grid": True,
    "grid.color": GRID,
    "grid.linewidth": 0.6,
    "font.size": 9,
    "axes.titlesize": 11,
    "axes.titleweight": "600",
}


def _new_figure(width: float = 7.0, height: float = 4.2):
    plt.rcParams.update(_BASE_STYLE)
    fig, ax = plt.subplots(figsize=(width, height))
    return fig, ax


def _save(fig, path: str) -> str:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    fig.tight_layout()
    fig.savefig(target, dpi=140, bbox_inches="tight")
    plt.close(fig)
    return str(target)


def plot_roc(curves: dict[str, tuple[np.ndarray, np.ndarray, float]], path: str) -> str:
    """Overlay ROC curves for every model on one axis."""
    fig, ax = _new_figure(6.2, 4.6)
    colours = [ACCENT, WARN, PROTECT, NEUTRAL]
    for index, (name, (fpr, tpr, auc)) in enumerate(curves.items()):
        ax.plot(
            fpr,
            tpr,
            color=colours[index % len(colours)],
            linewidth=1.8,
            label=f"{name} (AUC {auc:.3f})",
        )
    ax.plot([0, 1], [0, 1], color=NEUTRAL, linewidth=1, linestyle="--", label="Random")
    ax.set_xlabel("False positive rate")
    ax.set_ylabel("True positive rate")
    ax.set_title("ROC curves on the held-out test split")
    ax.set_xlim(-0.01, 1.01)
    ax.set_ylim(-0.01, 1.01)
    ax.legend(loc="lower right", frameon=False, fontsize=8)
    return _save(fig, path)


def plot_confusion_matrix(matrix: dict[str, int], path: str, title: str) -> str:
    """Render a 2x2 confusion matrix with counts written into each cell."""
    tn = matrix["true_negative"]
    fp = matrix["false_positive"]
    fn = matrix["false_negative"]
    tp = matrix["true_positive"]
    data = np.array([[tn, fp], [fn, tp]], dtype=float)

    fig, ax = _new_figure(4.4, 4.0)
    ax.imshow(data, cmap="Blues", vmin=0, vmax=max(data.max(), 1))

    labels = [
        ["Stayed (predicted)", "Churned (predicted)"],
        ["Stayed (actual)", "Churned (actual)"],
    ]
    ax.set_xticks([0, 1], labels[0], fontsize=8)
    ax.set_yticks([0, 1], labels[1], fontsize=8)
    ax.set_xlabel("Predicted")
    ax.set_ylabel("Actual")
    ax.set_title(title)

    total = data.sum()
    for row in range(2):
        for col in range(2):
            value = int(data[row, col])
            ax.text(
                col,
                row,
                f"{value}\n{value / total:.1%}",
                ha="center",
                va="center",
                fontsize=11,
                color="white" if data[row, col] > data.max() / 2 else INK,
            )
    ax.grid(False)
    return _save(fig, path)


def plot_decile_lift(rows: list[dict], baseline: float, path: str, title: str) -> str:
    """Churn rate per risk decile, with the baseline churn rate for reference."""
    fig, ax = _new_figure(6.6, 3.8)
    deciles = [row["decile"] for row in rows]
    rates = [row["churn_rate"] * 100 for row in rows]
    lifts = [row["lift"] for row in rows]

    bar_colours = [RISK if lift >= 1 else PROTECT for lift in lifts]
    ax.bar(deciles, rates, color=bar_colours, width=0.68)
    ax.axhline(
        baseline * 100,
        color=MUTED,
        linewidth=1.2,
        linestyle="--",
        label=f"Baseline churn rate {baseline:.1%}",
    )
    ax.set_xlabel("Decile (1 = highest predicted risk)")
    ax.set_ylabel("Churn rate (%)")
    ax.set_title(title)
    ax.set_xticks(deciles)
    ax.legend(loc="upper right", frameon=False, fontsize=8)
    ax.grid(axis="x", visible=False)
    return _save(fig, path)


def plot_shap_beeswarm(
    shap_matrix: np.ndarray,
    encoded_matrix: np.ndarray,
    feature_names: list[str],
    path: str,
    title: str,
    max_features: int = 15,
) -> str:
    """Beeswarm of per-customer SHAP values, top features only."""
    mean_abs = np.mean(np.abs(shap_matrix), axis=0)
    order = np.argsort(-mean_abs)[:max_features]
    order = order[::-1]  # most important at the top

    selected = shap_matrix[:, order]
    values = encoded_matrix[:, order]
    labels = [feature_names[i] for i in order]

    fig, ax = _new_figure(6.8, max(3.6, 0.28 * len(order) + 1.4))

    for row in range(selected.shape[1]):
        column_values = values[:, row]
        colour_values = column_values.astype(float)
        if np.ptp(colour_values) == 0:
            normalised = np.zeros_like(colour_values)
        else:
            normalised = (colour_values - colour_values.min()) / np.ptp(colour_values)
        ax.scatter(
            selected[:, row],
            np.full(selected.shape[0], row),
            c=normalised,
            cmap="coolwarm",
            s=7,
            alpha=0.75,
            linewidths=0,
            vmin=0,
            vmax=1,
        )

    ax.axvline(0, color=MUTED, linewidth=0.9)
    ax.set_yticks(range(len(labels)), labels, fontsize=7.5)
    ax.set_xlabel("SHAP value (contribution to predicted churn risk)")
    ax.set_title(title)
    ax.grid(axis="y", visible=False)
    return _save(fig, path)


def plot_shap_importance(
    rows: list[dict], path: str, title: str, max_features: int = 15
) -> str:
    """Ranked mean absolute SHAP value per feature."""
    subset = rows[:max_features]
    labels = [row["label"] for row in subset][::-1]
    values = [row["mean_abs_shap"] for row in subset][::-1]
    directions = [row["direction"] for row in subset][::-1]

    fig, ax = _new_figure(6.6, max(3.4, 0.28 * len(labels) + 1.2))
    colours = [
        RISK if d == "increases_risk" else (PROTECT if d == "reduces_risk" else NEUTRAL)
        for d in directions
    ]
    ax.barh(labels, values, color=colours, height=0.66)
    ax.set_xlabel("Mean absolute SHAP value")
    ax.set_title(title)
    ax.grid(axis="y", visible=False)
    ax.tick_params(axis="y", labelsize=7.5)
    return _save(fig, path)


def plot_shap_waterfall(
    contributions: list[dict], path: str, title: str, top_n: int = 10
) -> str:
    """Waterfall of the largest contributions for one customer."""
    subset = contributions[:top_n][::-1]
    labels = [item["label"] for item in subset]
    values = [item["shap_value"] for item in subset]

    running = 0.0
    starts: list[float] = []
    for value in values:
        starts.append(running)
        running += value

    fig, ax = _new_figure(6.8, max(3.2, 0.32 * len(labels) + 1.4))
    colours = [RISK if v > 0 else PROTECT for v in values]
    ax.barh(labels, values, left=starts, color=colours, height=0.62)
    ax.axvline(0, color=MUTED, linewidth=0.9)
    ax.set_xlabel("Change in predicted churn risk from the model base value")
    ax.set_title(title)
    ax.grid(axis="y", visible=False)
    ax.tick_params(axis="y", labelsize=7.5)
    return _save(fig, path)
