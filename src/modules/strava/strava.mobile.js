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
  const recentActivities = activities.slice(0, 24);
  const last7 = filterByDays(activities, 7);
  const last28 = filterByDays(activities, 28);
  const previous28 = filterByDaysBetween(activities, 56, 28);
  const displayName = deriveDisplayName(userEmail);

  const weekDistanceKm = round1(sum(last7, (item) => Number(item.distanceM ?? 0)) / 1000);
  const weekRuns = last7.length;
  const weekElevationGain = Math.round(sum(last7, (item) => Number(item.totalElevationGainM ?? 0)));
  const weekMovingHours = round2(sum(last7, (item) => Number(item.movingTimeSec ?? 0)) / 3600);
  const averagePaceMinKm7d = averagePaceMinKm(last7);
  const averagePaceLabel = formatPace(averagePaceMinKm7d);

  const longRun = recentActivities.reduce((acc, item) => {
    if (!acc) {
      return item;
    }
    return Number(item.distanceM ?? 0) > Number(acc.distanceM ?? 0) ? item : acc;
  }, null);
  const longRunDistanceKm = longRun ? Math.round(Number(longRun.distanceM ?? 0) / 1000) : 0;
  const longRunElevation = longRun ? Math.round(Number(longRun.totalElevationGainM ?? 0)) : 0;

  const enduranceIndex = clampScore(
    (weekDistanceKm * 1.3) +
    (longRunDistanceKm * 1.7) +
    (Math.min(weekMovingHours, 12) * 4.2)
  );
  const speedIndex = clampScore(
    paceToSpeedIndex(averagePaceMinKm7d)
  );

  const trailSessionCount = recentActivities.filter((item) => elevationPerKm(item) >= 20).length;
  const elevationDensity = weekDistanceKm > 0 ? weekElevationGain / weekDistanceKm : 0;
  const climbEfficiencyIndex = clampScore(
    (elevationDensity * 1.4) + (trailSessionCount * 7)
  );

  const activeDays28 = countActiveDays(last28);
  const weeklyDistanceSeries = groupByWeek(activities, 10).map((week) => round2(week.distanceKm));
  const distanceVariation = coefficientOfVariation(weeklyDistanceSeries);
  const consistencyIndex = clampScore(
    (activeDays28 * 3.1) + ((1 - Math.min(distanceVariation, 1)) * 35)
  );

  const acuteLoad = weekDistanceKm + (weekElevationGain / 120) + (weekRuns * 1.8);
  const chronicDistanceKm = round2(sum(last28, (item) => Number(item.distanceM ?? 0)) / 1000);
  const chronicLoad = (chronicDistanceKm / 4) + (sum(last28, (item) => Number(item.totalElevationGainM ?? 0)) / 480);
  const loadRatio = chronicLoad > 0 ? acuteLoad / chronicLoad : 0;

  const fallbackFatigue = clampScore((acuteLoad * 2.2) + (Math.max(loadRatio - 1, 0) * 48));
  const fatigueScore = clampScore(
    Number(analysis?.load?.fatigueScore ?? fallbackFatigue)
  );
  const fatigueZone = resolveFatigueZoneFr(fatigueScore);
  const recoveryIndex = clampScore(
    Number(analysis?.load?.readinessScore ?? (100 - fatigueScore))
  );

  const trailReadinessIndex = clampScore(
    (enduranceIndex * 0.40) +
    (climbEfficiencyIndex * 0.35) +
    (consistencyIndex * 0.25)
  );

  const runnerProfile = evaluateRunnerProfile({
    weekDistanceKm,
    weekRuns,
    weekElevationGain,
    averagePaceMinKm7d,
    trailSessionCount,
    longRunDistanceKm,
    activeDays28
  });

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
    weekDistanceKm: Math.round(weekDistanceKm),
    weekRuns,
    weekElevationGain,
    trainingLoad: Math.round(Number(analysis?.load?.acuteLoad7d ?? acuteLoad)),
    averagePace: averagePaceLabel
  };

  const insights = buildInsights({
    analysisInsights: analysis?.insights,
    weekDistanceKm,
    weekRuns,
    weekElevationGain,
    loadRatio,
    fatigueZone,
    longRunDistanceKm,
    elevationDensity,
    previous28DistanceKm: round1(
      sum(previous28, (item) => Number(item.distanceM ?? 0)) / 1000
    ),
    last28DistanceKm: round1(
      sum(last28, (item) => Number(item.distanceM ?? 0)) / 1000
    )
  });

  const readinessAdvice = resolveReadinessAdvice(fatigueZone, recoveryIndex);
  const focus = resolveFocus({
    fatigueScore,
    fatigueZone,
    enduranceIndex,
    speedIndex,
    climbEfficiencyIndex,
    consistencyIndex,
    trailReadinessIndex
  });

  return {
    profile: {
      displayName,
      runnerProfile
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
    focus
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

function filterByDaysBetween(activities, daysFrom, daysTo) {
  const minTs = Date.now() - (daysFrom * 24 * 60 * 60 * 1000);
  const maxTs = Date.now() - (daysTo * 24 * 60 * 60 * 1000);
  return activities.filter((item) => {
    const ts = new Date(item.startDate).getTime();
    return ts >= minTs && ts < maxTs;
  });
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

function evaluateRunnerProfile({
  weekDistanceKm,
  weekRuns,
  weekElevationGain,
  averagePaceMinKm7d,
  trailSessionCount,
  longRunDistanceKm,
  activeDays28
}) {
  const elevationDensity = weekDistanceKm > 0 ? weekElevationGain / weekDistanceKm : 0;

  if (trailSessionCount >= 2 && elevationDensity >= 28 && longRunDistanceKm >= 16) {
    return 'Traileur grimpeur';
  }
  if (weekDistanceKm >= 55 && weekRuns >= 5 && activeDays28 >= 14) {
    return 'Endurant structure';
  }
  if (averagePaceMinKm7d > 0 && averagePaceMinKm7d <= 4.75 && weekRuns >= 3) {
    return 'Coureur tempo';
  }
  if (weekRuns >= 4 && weekDistanceKm >= 30) {
    return 'Regulier en progression';
  }
  return 'Base en construction';
}

function buildInsights({
  analysisInsights,
  weekDistanceKm,
  weekRuns,
  weekElevationGain,
  loadRatio,
  fatigueZone,
  longRunDistanceKm,
  elevationDensity,
  previous28DistanceKm,
  last28DistanceKm
}) {
  const insights = [
    `Semaine: ${weekRuns} sorties, ${weekDistanceKm} km, D+ ${weekElevationGain} m.`
  ];

  if (fatigueZone === 'Rouge') {
    insights.push('Charge recente elevee: allege 24-48h et privilegie l’endurance facile.');
  } else if (loadRatio > 1.35) {
    insights.push('La charge monte vite cette semaine: garde une seance qualitative maximum.');
  } else if (loadRatio > 0 && loadRatio < 0.75) {
    insights.push('Charge plutot basse: tu peux reintroduire un bloc de progression.');
  } else {
    insights.push('Charge globalement bien progressive: bon contexte pour consolider.');
  }

  if (longRunDistanceKm >= 18) {
    insights.push(`Sortie longue solide (${longRunDistanceKm} km): bon marqueur d’endurance.`);
  } else if (elevationDensity >= 22) {
    insights.push(`Bloc D+ utile (${Math.round(elevationDensity)} m/km): transfert trail positif.`);
  } else if (previous28DistanceKm > 0 && last28DistanceKm > previous28DistanceKm * 1.15) {
    insights.push('Volume 28 jours en hausse: surveille recup et qualite du sommeil.');
  } else if (Array.isArray(analysisInsights) && analysisInsights.length > 0) {
    insights.push(String(analysisInsights[0]));
  } else {
    insights.push('Volume stable: continue avec une progression douce semaine apres semaine.');
  }

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
    const distanceKm = speedDistance / 1000;
    weeks.push({
      movingTimeSec,
      elevationM,
      distanceKm,
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

function averagePaceMinKm(activities) {
  const totalDistanceM = sum(activities, (item) => Number(item.distanceM ?? 0));
  const totalMovingSec = sum(activities, (item) => Number(item.movingTimeSec ?? 0));
  if (totalDistanceM <= 0 || totalMovingSec <= 0) {
    return 0;
  }
  return (totalMovingSec / 60) / (totalDistanceM / 1000);
}

function paceToSpeedIndex(paceMinKm) {
  if (!paceMinKm || paceMinKm <= 0) {
    return 0;
  }
  return (7.2 - paceMinKm) * 28;
}

function elevationPerKm(activity) {
  const distanceKm = Number(activity.distanceM ?? 0) / 1000;
  if (distanceKm <= 0.4) {
    return 0;
  }
  return Number(activity.totalElevationGainM ?? 0) / distanceKm;
}

function countActiveDays(activities) {
  const days = new Set(
    activities.map((item) => new Date(item.startDate).toISOString().slice(0, 10))
  );
  return days.size;
}

function coefficientOfVariation(values) {
  const clean = values.filter((value) => Number.isFinite(value) && value > 0);
  if (clean.length < 2) {
    return 0;
  }
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
  if (mean <= 0) {
    return 0;
  }
  const variance = clean.reduce((acc, value) => acc + ((value - mean) ** 2), 0) / clean.length;
  return Math.sqrt(variance) / mean;
}

function resolveFocus({
  fatigueScore,
  fatigueZone,
  enduranceIndex,
  speedIndex,
  climbEfficiencyIndex,
  consistencyIndex,
  trailReadinessIndex
}) {
  if (fatigueZone === 'Rouge' || fatigueScore >= 75) {
    return {
      focusTitle: 'Focus recuperation 5 jours',
      focusSubtitle: 'Priorite: reduire la fatigue avant de relancer un bloc qualitatif.'
    };
  }

  const weaknesses = [
    { key: 'endurance', score: enduranceIndex },
    { key: 'vitesse', score: speedIndex },
    { key: 'dplus', score: climbEfficiencyIndex },
    { key: 'regularite', score: consistencyIndex }
  ].sort((a, b) => a.score - b.score);

  switch (weaknesses[0].key) {
    case 'endurance':
      return {
        focusTitle: 'Focus endurance 10 jours',
        focusSubtitle: 'Priorite: augmenter progressivement volume facile et sortie longue.'
      };
    case 'vitesse':
      return {
        focusTitle: 'Focus qualite allure 10 jours',
        focusSubtitle: 'Priorite: ajouter une seance tempo courte avec recup complete.'
      };
    case 'dplus':
      return {
        focusTitle: 'Focus montee 10 jours',
        focusSubtitle: 'Priorite: renforcer D+ specifique trail sur terrain vallonne.'
      };
    default:
      return {
        focusTitle: trailReadinessIndex >= 65
          ? 'Focus bloc trail 10 jours'
          : 'Focus regularite 10 jours',
        focusSubtitle: trailReadinessIndex >= 65
          ? 'Priorite: consolider endurance et capacite en montee (D+).'
          : 'Priorite: stabiliser le rythme hebdo avec 3-4 sorties constantes.'
      };
  }
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

module.exports = {
  toEnrichedActivity,
  buildDashboardData,
  pickWidgets
};
