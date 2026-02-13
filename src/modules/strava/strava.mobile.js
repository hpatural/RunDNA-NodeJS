function buildActivityAnalysis(activity) {
  const distanceKm = Number(activity.distanceM ?? 0) / 1000;
  const durationMinutes = Math.round(Number(activity.movingTimeSec ?? 0) / 60);
  const paceMinPerKm = computePaceMinPerKm(activity);
  const elevationGain = Math.round(Number(activity.totalElevationGainM ?? 0));
  const avgHeartRate = Math.round(Number(activity.averageHeartRate ?? 0));

  const intensityRaw =
    ((6.5 - paceMinPerKm) * 18) +
    ((avgHeartRate - 130) * 1.2) +
    (elevationGain / 22);
  const intensity = clampScore(intensityRaw);

  const enduranceRaw =
    (durationMinutes * 0.9) + (distanceKm * 1.6) + (elevationGain / 16);
  const endurance = clampScore(enduranceRaw / 1.8);

  const variability =
    ((elevationGain / Math.max(distanceKm, 0.2)) / 14) +
    (Math.abs(paceMinPerKm - 4.5) * 8);
  const stability = clampScore(100 - variability);

  const elevationStress = clampScore(elevationGain / 8.5);
  const recoveryRaw =
    (intensity * 0.55) + (endurance * 0.45) + (elevationStress * 0.15);
  const recovery = clampScore(recoveryRaw);

  return {
    intensityScore: intensity,
    enduranceLoad: endurance,
    pacingStability: stability,
    elevationStress,
    recoveryCost: recovery
  };
}

function toEnrichedActivity(activity) {
  const paceMinPerKm = computePaceMinPerKm(activity);
  const averageHeartRate = Number(activity.averageHeartRate ?? 0);
  return {
    id: String(activity.activityId),
    provider: 'strava',
    startTime: activity.startDate,
    durationMinutes: Math.round(Number(activity.movingTimeSec ?? 0) / 60),
    distanceKm: round2(Number(activity.distanceM ?? 0) / 1000),
    paceMinPerKm: paceMinPerKm > 0 ? round2(paceMinPerKm) : 0,
    elevationGain: Math.round(Number(activity.totalElevationGainM ?? 0)),
    avgHeartRate: averageHeartRate > 0 ? Math.round(averageHeartRate) : 0,
    analysis: buildActivityAnalysis(activity)
  };
}

function buildDashboardData({ userEmail, activities, analysis }) {
  const recentActivities = activities.slice(0, 20);
  const last7 = filterByDays(activities, 7);
  const last30 = filterByDays(activities, 30);
  const displayName = deriveDisplayName(userEmail);
  const fatigueScore = clampScore(Number(analysis?.load?.fatigueScore ?? 0));
  const fatigueZone = resolveFatigueZoneFr(fatigueScore);
  const readinessScore = clampScore(Number(analysis?.load?.readinessScore ?? 0));

  const longRun = recentActivities.reduce((acc, item) => {
    if (!acc) {
      return item;
    }
    return Number(item.distanceM ?? 0) > Number(acc.distanceM ?? 0) ? item : acc;
  }, null);

  const trendWeeks = groupByWeek(activities, 10);
  const speedTrend = normalizeTrend(
    trendWeeks.map((week) => week.avgSpeedMps)
  );
  const enduranceTrend = normalizeTrend(
    trendWeeks.map((week) => week.movingTimeSec)
  );
  const elevationTrend = normalizeTrend(
    trendWeeks.map((week) => week.elevationM)
  );

  const quickStats = {
    weekDistanceKm: Math.round(sum(last7, (item) => Number(item.distanceM ?? 0)) / 1000),
    weekRuns: last7.length,
    weekElevationGain: Math.round(sum(last7, (item) => Number(item.totalElevationGainM ?? 0))),
    trainingLoad: Math.round(Number(analysis?.load?.acuteLoad7d ?? 0)),
    averagePace: formatPace(
      Number(analysis?.summary?.avgPaceMinKm7d ?? 0)
    )
  };

  const longRunDistanceKm = longRun ? Math.round(Number(longRun.distanceM ?? 0) / 1000) : 0;
  const longRunElevation = longRun ? Math.round(Number(longRun.totalElevationGainM ?? 0)) : 0;
  const enduranceIndex = clampScore(
    analysis?.summary?.movingTimeHours30d
      ? Number(analysis.summary.movingTimeHours30d) * 2.4
      : sum(last30, (item) => Number(item.movingTimeSec ?? 0)) / 1800
  );
  const speedIndex = clampScore(
    analysis?.summary?.avgPaceMinKm7d
      ? (7 - Number(analysis.summary.avgPaceMinKm7d)) * 38
      : sum(last7, (item) => Number(item.averageSpeedMps ?? 0)) * 6
  );
  const recoveryIndex = clampScore(readinessScore);
  const consistencyIndex = clampScore(last30.length * 4.5);
  const climbEfficiencyIndex = clampScore(
    quickStats.weekElevationGain / Math.max(quickStats.weekDistanceKm, 1.2)
  );
  const trailReadinessIndex = clampScore(
    (enduranceIndex * 0.45) +
    (climbEfficiencyIndex * 0.35) +
    (consistencyIndex * 0.2)
  );

  const insights = buildInsights({
    analysisInsights: analysis?.insights,
    weekDistanceKm: quickStats.weekDistanceKm,
    weekRuns: quickStats.weekRuns,
    weekElevationGain: quickStats.weekElevationGain,
    fatigueZone
  });

  const readinessAdvice = resolveReadinessAdvice(fatigueZone, readinessScore);

  return {
    profile: {
      displayName,
      runnerProfile: resolveRunnerProfile(quickStats)
    },
    fatigue: {
      fatigueScore,
      fatigueZone,
      readinessAdvice
    },
    quickStats,
    elevationFocus: {
      longRunDistanceKm,
      longRunElevation
    },
    progressCurves: {
      enduranceIndex,
      speedIndex,
      recoveryIndex,
      consistencyIndex,
      climbEfficiencyIndex,
      trailReadinessIndex,
      speedTrend,
      enduranceTrend,
      elevationTrend
    },
    insights: {
      items: insights
    },
    focus: {
      focusTitle: 'Focus bloc trail 10 jours',
      focusSubtitle: readinessScore < 40
        ? 'Priorite: absorber la charge et reduire la dette de recup.'
        : 'Priorite: consolider endurance et capacite en montee (D+).'
    }
  };
}

function pickWidgets(allWidgets, requested) {
  if (!Array.isArray(requested) || requested.length === 0) {
    return allWidgets;
  }
  const allowed = new Set([
    'profile',
    'fatigue',
    'quickStats',
    'elevationFocus',
    'progressCurves',
    'insights',
    'focus'
  ]);
  const filtered = {};
  for (const key of requested) {
    if (allowed.has(key) && Object.prototype.hasOwnProperty.call(allWidgets, key)) {
      filtered[key] = allWidgets[key];
    }
  }
  return filtered;
}

function computePaceMinPerKm(activity) {
  const distanceM = Number(activity.distanceM ?? 0);
  const movingTimeSec = Number(activity.movingTimeSec ?? 0);
  if (distanceM <= 0 || movingTimeSec <= 0) {
    return 0;
  }
  return (movingTimeSec / 60) / (distanceM / 1000);
}

function filterByDays(activities, days) {
  const threshold = Date.now() - days * 24 * 60 * 60 * 1000;
  return activities.filter((item) => new Date(item.startDate).getTime() >= threshold);
}

function sum(list, mapper) {
  let value = 0;
  for (const item of list) {
    value += mapper(item);
  }
  return value;
}

function deriveDisplayName(email) {
  if (!email || typeof email !== 'string') {
    return 'Athlete';
  }
  const local = email.split('@')[0] || 'Athlete';
  return local
    .split(/[._-]/g)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}

function resolveFatigueZoneFr(fatigueScore) {
  if (fatigueScore <= 45) {
    return 'Vert';
  }
  if (fatigueScore <= 70) {
    return 'Orange';
  }
  return 'Rouge';
}

function resolveReadinessAdvice(fatigueZone, readinessScore) {
  if (fatigueZone === 'Rouge' || readinessScore < 35) {
    return 'Fatigue elevee. Priorise recuperation, mobilite et footing facile.';
  }
  if (fatigueZone === 'Orange') {
    return 'Charge correcte. Une seance cle max, puis recup active.';
  }
  return 'Bonne fraicheur. Tu peux monter un peu le volume ou le D+.';
}

function resolveRunnerProfile({ weekDistanceKm, weekRuns, weekElevationGain }) {
  if (weekElevationGain >= 900 && weekRuns >= 3) {
    return 'Traileur en developpement';
  }
  if (weekDistanceKm >= 45) {
    return 'Endurant diesel';
  }
  if (weekRuns >= 4) {
    return 'Regulier prudent';
  }
  return 'Debutant progressif';
}

function buildInsights({
  analysisInsights,
  weekDistanceKm,
  weekRuns,
  weekElevationGain,
  fatigueZone
}) {
  const insights = [
    `Semaine: ${weekRuns} sorties, ${weekDistanceKm} km, D+ ${weekElevationGain} m.`
  ];

  if (Array.isArray(analysisInsights) && analysisInsights.length > 0) {
    insights.push(...analysisInsights.slice(0, 2));
  } else if (fatigueZone === 'Rouge') {
    insights.push('Le ratio charge recente/chronique est haut, risque de surcharge en hausse.');
  } else {
    insights.push('La charge est globalement progressive, bon contexte pour continuer a construire.');
  }

  insights.push('Tendance: endurance stable, vitesse en hausse legere, D+ en progression.');
  return insights.slice(0, 3);
}

function groupByWeek(activities, weeksCount) {
  const now = new Date();
  const weeks = [];
  for (let i = weeksCount - 1; i >= 0; i -= 1) {
    const end = new Date(now);
    end.setUTCDate(now.getUTCDate() - (i * 7));
    const start = new Date(end);
    start.setUTCDate(end.getUTCDate() - 7);
    const bucket = activities.filter((item) => {
      const ts = new Date(item.startDate).getTime();
      return ts >= start.getTime() && ts < end.getTime();
    });
    const movingTimeSec = sum(bucket, (item) => Number(item.movingTimeSec ?? 0));
    const elevationM = sum(bucket, (item) => Number(item.totalElevationGainM ?? 0));
    const speedDistance = sum(bucket, (item) => Number(item.distanceM ?? 0));
    const speedDuration = movingTimeSec;
    weeks.push({
      movingTimeSec,
      elevationM,
      avgSpeedMps: speedDuration > 0 ? speedDistance / speedDuration : 0
    });
  }
  return weeks;
}

function normalizeTrend(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return [];
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max <= min) {
    return values.map(() => 0.45);
  }
  return values.map((value) => round2(0.2 + 0.75 * ((value - min) / (max - min))));
}

function formatPace(paceMinPerKm) {
  if (!paceMinPerKm || paceMinPerKm <= 0 || Number.isNaN(paceMinPerKm)) {
    return '0:00/km';
  }
  const minutes = Math.floor(paceMinPerKm);
  const seconds = Math.round((paceMinPerKm - minutes) * 60);
  const normalizedMinutes = seconds === 60 ? minutes + 1 : minutes;
  const normalizedSeconds = seconds === 60 ? 0 : seconds;
  return `${normalizedMinutes}:${String(normalizedSeconds).padStart(2, '0')}/km`;
}

function clampScore(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 100) {
    return 100;
  }
  return Math.round(value);
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

module.exports = {
  toEnrichedActivity,
  buildDashboardData,
  pickWidgets
};
