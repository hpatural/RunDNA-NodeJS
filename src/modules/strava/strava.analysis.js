const DEFAULT_MAX_HEART_RATE = 190;

function analyzeStravaActivities(activities) {
  const sorted = [...activities].sort(
    (a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime()
  );
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  const last7 = sorted.filter(
    (item) => now - new Date(item.startDate).getTime() <= 7 * dayMs
  );
  const last30 = sorted.filter(
    (item) => now - new Date(item.startDate).getTime() <= 30 * dayMs
  );
  const previous7 = sorted.filter((item) => {
    const age = now - new Date(item.startDate).getTime();
    return age > 7 * dayMs && age <= 14 * dayMs;
  });

  const totals7 = buildTotals(last7);
  const totals30 = buildTotals(last30);
  const totalsPrev7 = buildTotals(previous7);

  const chronicLoad = totals30.trainingLoad / 4;
  const acuteLoad = totals7.trainingLoad;
  const fatigueScore = chronicLoad > 0 ? Math.round((acuteLoad / chronicLoad) * 100) : 0;
  const readinessScore = Math.max(0, Math.min(100, Math.round(110 - fatigueScore)));
  const paceTrendPct = totalsPrev7.avgSpeedMps
    ? ((totals7.avgSpeedMps - totalsPrev7.avgSpeedMps) / totalsPrev7.avgSpeedMps) * 100
    : null;

  return {
    summary: {
      activities7d: last7.length,
      activities30d: last30.length,
      distanceKm7d: round2(totals7.distanceM / 1000),
      distanceKm30d: round2(totals30.distanceM / 1000),
      elevationM7d: Math.round(totals7.elevationM),
      elevationM30d: Math.round(totals30.elevationM),
      movingTimeHours7d: round2(totals7.movingTimeSec / 3600),
      movingTimeHours30d: round2(totals30.movingTimeSec / 3600),
      avgPaceMinKm7d: totals7.avgSpeedMps ? round2(1000 / totals7.avgSpeedMps / 60) : null,
      avgHeartRate7d: totals7.heartRateSamples > 0
        ? Math.round(totals7.heartRateSum / totals7.heartRateSamples)
        : null
    },
    load: {
      acuteLoad7d: Math.round(acuteLoad),
      chronicLoad28d: Math.round(chronicLoad),
      fatigueScore,
      readinessScore,
      monotony7d: round2(computeMonotony(last7))
    },
    trends: {
      paceTrendPct7dVsPrevious7d: paceTrendPct === null ? null : round2(paceTrendPct)
    },
    insights: buildInsights({ fatigueScore, readinessScore, paceTrendPct, totals7, last7 })
  };
}

function buildTotals(activities) {
  let distanceM = 0;
  let elevationM = 0;
  let movingTimeSec = 0;
  let weightedSpeed = 0;
  let speedWeight = 0;
  let heartRateSum = 0;
  let heartRateSamples = 0;
  let trainingLoad = 0;

  for (const item of activities) {
    const distance = Number(item.distanceM ?? 0);
    const elevation = Number(item.totalElevationGainM ?? 0);
    const movingTime = Number(item.movingTimeSec ?? 0);
    const averageSpeed = Number(item.averageSpeedMps ?? 0);
    const averageHeartRate = Number(item.averageHeartRate ?? 0);

    distanceM += distance;
    elevationM += elevation;
    movingTimeSec += movingTime;

    if (averageSpeed > 0 && movingTime > 0) {
      weightedSpeed += averageSpeed * movingTime;
      speedWeight += movingTime;
    }
    if (averageHeartRate > 0) {
      heartRateSum += averageHeartRate;
      heartRateSamples += 1;
    }

    trainingLoad += estimateTrainingLoad({
      movingTimeSec: movingTime,
      averageHeartRate,
      relativeEffortScore: Number(item.relativeEffortScore ?? 0)
    });
  }

  return {
    distanceM,
    elevationM,
    movingTimeSec,
    avgSpeedMps: speedWeight > 0 ? weightedSpeed / speedWeight : 0,
    heartRateSum,
    heartRateSamples,
    trainingLoad
  };
}

function estimateTrainingLoad({ movingTimeSec, averageHeartRate, relativeEffortScore = 0 }) {
  const durationMinutes = movingTimeSec / 60;
  if (durationMinutes <= 0) {
    return 0;
  }

  const relativeEffortBonus = Number.isFinite(relativeEffortScore) && relativeEffortScore > 0
    ? relativeEffortScore * 0.8
    : 0;

  if (!averageHeartRate || averageHeartRate <= 0) {
    return (durationMinutes * 1.8) + relativeEffortBonus;
  }

  const hrRatio = Math.min(1.05, averageHeartRate / DEFAULT_MAX_HEART_RATE);
  const intensityFactor = 1 + hrRatio * 2.2;
  return (durationMinutes * intensityFactor) + relativeEffortBonus;
}

function computeMonotony(activities) {
  if (activities.length === 0) {
    return 0;
  }
  const dayLoads = new Map();
  for (const activity of activities) {
    const dateKey = new Date(activity.startDate).toISOString().slice(0, 10);
    const current = dayLoads.get(dateKey) ?? 0;
    dayLoads.set(
      dateKey,
      current + estimateTrainingLoad({
        movingTimeSec: Number(activity.movingTimeSec ?? 0),
        averageHeartRate: Number(activity.averageHeartRate ?? 0),
        relativeEffortScore: Number(activity.relativeEffortScore ?? 0)
      })
    );
  }

  const loads = Array.from(dayLoads.values());
  const mean = loads.reduce((sum, value) => sum + value, 0) / loads.length;
  if (loads.length === 1) {
    return mean > 0 ? 2 : 0;
  }
  const variance = loads.reduce((sum, value) => sum + (value - mean) ** 2, 0) / loads.length;
  const stddev = Math.sqrt(variance);
  if (stddev === 0) {
    return mean > 0 ? 3 : 0;
  }
  return mean / stddev;
}

function buildInsights({ fatigueScore, readinessScore, paceTrendPct, totals7, last7 }) {
  const insights = [];

  if (last7.length === 0) {
    insights.push('Aucune activite recente Strava pour analyser la charge.');
    return insights;
  }

  if (fatigueScore >= 140) {
    insights.push('Charge aigue elevee vs charge chronique: prevoir 24-48h de recuperation active.');
  } else if (fatigueScore <= 70) {
    insights.push('Charge recente faible: possible fenetre pour reconstruire le volume.');
  } else {
    insights.push('Equilibre charge/recovery globalement stable cette semaine.');
  }

  if (readinessScore < 40) {
    insights.push('Readiness basse: reduire intensite et privilegier endurance fondamentale.');
  } else if (readinessScore > 70) {
    insights.push('Readiness correcte: une seance qualitative peut etre placee.');
  }

  if (paceTrendPct !== null) {
    if (paceTrendPct <= -3) {
      insights.push('Allure moyenne en baisse vs semaine precedente: surveiller fatigue et sommeil.');
    } else if (paceTrendPct >= 3) {
      insights.push('Allure moyenne en progression vs semaine precedente.');
    }
  }

  if (totals7.elevationM >= 1200) {
    insights.push('Volume D+ eleve cette semaine: renforcer la recuperation musculaire.');
  }

  return insights;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

module.exports = { analyzeStravaActivities };
