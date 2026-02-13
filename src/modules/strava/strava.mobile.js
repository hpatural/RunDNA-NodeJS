function buildActivityAnalysis(activity, { baseline } = {}) {
  const metrics = computeActivityMetrics(activity);

  if (!baseline || baseline.activityCount < 6) {
    return buildAbsoluteActivityAnalysis(activity);
  }

  const intensity = weightedScore([
    {
      score: percentileScore(
        baseline.series.relativeEffort,
        metrics.relativeEffortScore,
        { higherIsBetter: true }
      ),
      weight: 0.35
    },
    {
      score: percentileScore(baseline.series.speedMps, metrics.speedMps, { higherIsBetter: true }),
      weight: 0.3
    },
    {
      score: percentileScore(baseline.series.heartRate, metrics.averageHeartRate, { higherIsBetter: true }),
      weight: 0.2
    },
    {
      score: percentileScore(baseline.series.elevationPerKm, metrics.elevationPerKm, { higherIsBetter: true }),
      weight: 0.15
    }
  ]);

  const endurance = weightedScore([
    {
      score: percentileScore(baseline.series.trainingLoad, metrics.trainingLoad, { higherIsBetter: true }),
      weight: 0.45
    },
    {
      score: percentileScore(baseline.series.distanceKm, metrics.distanceKm, { higherIsBetter: true }),
      weight: 0.35
    },
    {
      score: percentileScore(baseline.series.durationMinutes, metrics.durationMinutes, { higherIsBetter: true }),
      weight: 0.2
    }
  ]);

  const paceDeviation =
    metrics.paceMinPerKm > 0 && baseline.medianPaceMinPerKm > 0
      ? Math.abs(metrics.paceMinPerKm - baseline.medianPaceMinPerKm) / baseline.medianPaceMinPerKm
      : null;
  const stability = paceDeviation === null
    ? 50
    : percentileScore(baseline.series.paceDeviationRatio, paceDeviation, { higherIsBetter: false });

  const elevationStress = percentileScore(
    baseline.series.elevationPerKm,
    metrics.elevationPerKm,
    { higherIsBetter: true }
  );

  const recovery = weightedScore([
    { score: intensity, weight: 0.5 },
    { score: endurance, weight: 0.35 },
    { score: elevationStress, weight: 0.15 }
  ]);

  return {
    intensityScore: intensity,
    enduranceLoad: endurance,
    pacingStability: stability,
    elevationStress,
    recoveryCost: recovery
  };
}

function buildAbsoluteActivityAnalysis(activity) {
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

function toEnrichedActivity(activity, { baseline } = {}) {
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
    analysis: buildActivityAnalysis(activity, { baseline })
  };
}

function buildDashboardData({ userEmail, activities, analysis, baselineActivities }) {
  const recentActivities = activities.slice(0, 24);
  const currentWeek = filterCurrentWeekFromMonday(activities);
  const last28 = filterByDays(activities, 28);
  const previous28 = filterByDaysBetween(activities, 56, 28);
  const displayName = deriveDisplayName(userEmail);

  const baseline = buildUserBaseline(
    Array.isArray(baselineActivities) && baselineActivities.length > 0
      ? baselineActivities
      : activities
  );
  const weeklyBaseline = baseline.weekly;

  const weekDistanceKm = round1(sum(currentWeek, (item) => Number(item.distanceM ?? 0)) / 1000);
  const weekRuns = currentWeek.length;
  const weekElevationGain = Math.round(sum(currentWeek, (item) => Number(item.totalElevationGainM ?? 0)));
  const weekMovingHours = round2(sum(currentWeek, (item) => Number(item.movingTimeSec ?? 0)) / 3600);
  const averagePaceMinKm7d = averagePaceMinKm(currentWeek);
  const averagePaceLabel = formatPace(averagePaceMinKm7d);

  const longRun = recentActivities.reduce((acc, item) => {
    if (!acc) {
      return item;
    }
    return Number(item.distanceM ?? 0) > Number(acc.distanceM ?? 0) ? item : acc;
  }, null);
  const longRunDistanceKm = longRun ? Math.round(Number(longRun.distanceM ?? 0) / 1000) : 0;
  const longRunElevation = longRun ? Math.round(Number(longRun.totalElevationGainM ?? 0)) : 0;

  const weekDistanceScore = percentileScore(weeklyBaseline.distanceKm, weekDistanceKm, {
    higherIsBetter: true
  });
  const weekMovingTimeScore = percentileScore(weeklyBaseline.movingHours, weekMovingHours, {
    higherIsBetter: true
  });
  const longRunScore = percentileScore(weeklyBaseline.longRunKm, longRunDistanceKm, {
    higherIsBetter: true
  });

  const enduranceIndex = weightedScore([
    { score: weekDistanceScore, weight: 0.5 },
    { score: longRunScore, weight: 0.3 },
    { score: weekMovingTimeScore, weight: 0.2 }
  ]);

  const weekAvgSpeedMps = paceToSpeedMps(averagePaceMinKm7d);
  const speedIndex = percentileScore(weeklyBaseline.avgSpeedMps, weekAvgSpeedMps, {
    higherIsBetter: true
  });

  const trailSessionCount = recentActivities.filter((item) => elevationPerKm(item) >= 20).length;
  const elevationDensity = weekDistanceKm > 0 ? weekElevationGain / weekDistanceKm : 0;
  const elevationDensityScore = percentileScore(
    weeklyBaseline.elevationDensity,
    elevationDensity,
    { higherIsBetter: true }
  );
  const weeklyTrailSessionScore = percentileScore(
    weeklyBaseline.trailSessions,
    trailSessionCount,
    { higherIsBetter: true }
  );

  const climbEfficiencyIndex = weightedScore([
    { score: elevationDensityScore, weight: 0.65 },
    { score: weeklyTrailSessionScore, weight: 0.35 }
  ]);

  const activeDays28 = countActiveDays(last28);
  const weeklyDistanceSeries = groupByWeek(activities, 10).map((week) => round2(week.distanceKm));
  const distanceVariation = coefficientOfVariation(weeklyDistanceSeries);
  const activeDaysScore = percentileScore(weeklyBaseline.activeDays, activeDays28 / 4, {
    higherIsBetter: true
  });
  const regularityScore = percentileScore(weeklyBaseline.distanceVariation, distanceVariation, {
    higherIsBetter: false
  });

  const consistencyIndex = weightedScore([
    { score: activeDaysScore, weight: 0.55 },
    { score: regularityScore, weight: 0.45 }
  ]);

  const acuteLoad = weekDistanceKm + (weekElevationGain / 120) + (weekRuns * 1.8);
  const chronicDistanceKm = round2(sum(last28, (item) => Number(item.distanceM ?? 0)) / 1000);
  const chronicLoad =
    (chronicDistanceKm / 4) + (sum(last28, (item) => Number(item.totalElevationGainM ?? 0)) / 480);
  const loadRatio = chronicLoad > 0 ? acuteLoad / chronicLoad : 0;

  const fallbackFatigue = clampScore((acuteLoad * 2.2) + (Math.max(loadRatio - 1, 0) * 48));
  const fatigueScore = clampScore(
    Number(analysis?.load?.fatigueScore ?? fallbackFatigue)
  );
  const fatigueZone = resolveFatigueZoneFr(fatigueScore);
  const recoveryIndex = clampScore(
    Number(analysis?.load?.readinessScore ?? (100 - fatigueScore))
  );

  const trailReadinessIndex = weightedScore([
    { score: enduranceIndex, weight: 0.4 },
    { score: climbEfficiencyIndex, weight: 0.35 },
    { score: consistencyIndex, weight: 0.25 }
  ]);

  const runnerProfile = evaluateRunnerProfile({
    enduranceIndex,
    speedIndex,
    climbEfficiencyIndex,
    consistencyIndex
  });

  const trendWeeks = groupByWeek(activities, 10);
  const weeklyComparisons = computeWeeklyComparisons(trendWeeks, 3);
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

  const trainingDistribution = computeIntensityDistribution(last28, baseline);
  const trainingLoadBalance = buildTrainingLoadBalance({
    acuteLoad,
    chronicLoad,
    analysis
  });
  const weeklyTarget = buildWeeklyTarget({
    weekDistanceKm,
    trendWeeks,
    weeklyBaseline
  });
  const consistency = buildConsistencySnapshot({
    currentWeek,
    trendWeeks,
    weeklyBaseline
  });

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
    ),
    baselineWeekDistanceKm: weeklyBaseline.distanceMedian,
    baselineLongRunKm: weeklyBaseline.longRunMedian,
    speedDeltaPct: weeklyComparisons.speedDeltaPct,
    volumeDeltaPct: weeklyComparisons.volumeDeltaPct,
    elevationDeltaPct: weeklyComparisons.elevationDeltaPct
  });

  const readinessAdvice = resolveReadinessAdvice(fatigueZone, recoveryIndex);
  const focus = resolveFocus({
    fatigueScore,
    fatigueZone,
    enduranceIndex,
    speedIndex,
    climbEfficiencyIndex,
    consistencyIndex,
    trailReadinessIndex,
    loadRatio
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
    trainingDistribution,
    trainingLoadBalance,
    weeklyTarget,
    consistency,
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
      elevationTrend,
      speedDeltaPct: weeklyComparisons.speedDeltaPct,
      volumeDeltaPct: weeklyComparisons.volumeDeltaPct,
      elevationDeltaPct: weeklyComparisons.elevationDeltaPct
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
    'trainingDistribution',
    'trainingLoadBalance',
    'weeklyTarget',
    'consistency',
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

function filterCurrentWeekFromMonday(activities) {
  const now = new Date();
  const currentDay = now.getDay() === 0 ? 7 : now.getDay();
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(now.getDate() - (currentDay - 1));
  const mondayTs = monday.getTime();
  return activities.filter((item) => new Date(item.startDate).getTime() >= mondayTs);
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
  enduranceIndex,
  speedIndex,
  climbEfficiencyIndex,
  consistencyIndex
}) {
  const axes = [
    { key: 'endurance', score: enduranceIndex },
    { key: 'speed', score: speedIndex },
    { key: 'climb', score: climbEfficiencyIndex },
    { key: 'consistency', score: consistencyIndex }
  ].sort((a, b) => b.score - a.score);

  if (axes[0].key === 'climb' && axes[0].score >= 60) {
    return 'Traileur grimpeur';
  }
  if (axes[0].key === 'endurance' && axes[0].score >= 60) {
    return 'Endurant structure';
  }
  if (axes[0].key === 'speed' && axes[0].score >= 60) {
    return 'Coureur tempo';
  }
  if (consistencyIndex >= 55) {
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
  last28DistanceKm,
  baselineWeekDistanceKm,
  baselineLongRunKm,
  speedDeltaPct,
  volumeDeltaPct,
  elevationDeltaPct
}) {
  const insights = [
    `Semaine: ${weekRuns} sorties, ${weekDistanceKm} km, D+ ${weekElevationGain} m.`
  ];

  insights.push(
    `Vs 3 semaines precedentes: vitesse ${formatSignedPct(speedDeltaPct)}, volume ${formatSignedPct(volumeDeltaPct)}, D+ ${formatSignedPct(elevationDeltaPct)}.`
  );

  const weekVsBaseline = percentDelta(weekDistanceKm, baselineWeekDistanceKm);
  const longRunVsBaseline = percentDelta(longRunDistanceKm, baselineLongRunKm);

  if (fatigueZone === 'Rouge') {
    insights.push('Charge trop elevee: fais 2 jours faciles, puis une seule seance de qualite cette semaine.');
  } else if (loadRatio > 1.35) {
    insights.push('Tu charges vite: garde une seance intense max et privilegie la recuperation active.');
  } else if (Number.isFinite(longRunVsBaseline) && longRunVsBaseline >= 20) {
    insights.push('Sortie longue au-dessus de ton niveau habituel: bonne progression d endurance.');
  } else if (Number.isFinite(weekVsBaseline) && weekVsBaseline >= 25) {
    insights.push('Volume hebdo nettement au-dessus de ta base: surveille recup et sommeil.');
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
    const activeDays = countActiveDays(bucket);
    const trailSessions = bucket.filter((item) => elevationPerKm(item) >= 20).length;
    const longRunKm = bucket.reduce((acc, item) => {
      const currentKm = Number(item.distanceM ?? 0) / 1000;
      return currentKm > acc ? currentKm : acc;
    }, 0);
    weeks.push({
      movingTimeSec,
      elevationM,
      distanceKm,
      activeDays,
      trailSessions,
      longRunKm,
      elevationDensity: distanceKm > 0 ? elevationM / distanceKm : 0,
      avgSpeedMps: speedDuration > 0 ? speedDistance / speedDuration : 0
    });
  }
  return weeks;
}

function buildUserBaseline(activities) {
  const cleanActivities = Array.isArray(activities)
    ? activities.filter((item) => Number(item.distanceM ?? 0) > 0 && Number(item.movingTimeSec ?? 0) > 0)
    : [];
  const metrics = cleanActivities.map((item) => computeActivityMetrics(item));

  const paceSamples = metrics.map((item) => item.paceMinPerKm).filter((value) => value > 0);
  const medianPaceMinPerKm = median(paceSamples);
  const paceDeviationRatio = metrics
    .map((item) => {
      if (item.paceMinPerKm <= 0 || medianPaceMinPerKm <= 0) {
        return null;
      }
      return Math.abs(item.paceMinPerKm - medianPaceMinPerKm) / medianPaceMinPerKm;
    })
    .filter((value) => Number.isFinite(value));

  const weekly = groupByWeek(cleanActivities, 12);
  const weeklyDistance = weekly.map((item) => item.distanceKm).filter((value) => value > 0);
  const weeklyMovingHours = weekly.map((item) => item.movingTimeSec / 3600).filter((value) => value > 0);
  const weeklyLongRun = weekly.map((item) => item.longRunKm).filter((value) => value > 0);
  const weeklySpeed = weekly.map((item) => item.avgSpeedMps).filter((value) => value > 0);
  const weeklyElevationDensity = weekly
    .map((item) => item.elevationDensity)
    .filter((value) => Number.isFinite(value) && value >= 0);
  const weeklyTrailSessions = weekly
    .map((item) => item.trailSessions)
    .filter((value) => Number.isFinite(value) && value >= 0);
  const weeklyActiveDays = weekly
    .map((item) => item.activeDays)
    .filter((value) => Number.isFinite(value) && value >= 0);

  const rollingDistanceVariation = [];
  for (let i = 0; i <= weekly.length - 4; i += 1) {
    rollingDistanceVariation.push(
      coefficientOfVariation(weekly.slice(i, i + 4).map((item) => item.distanceKm))
    );
  }

  return {
    activityCount: metrics.length,
    medianPaceMinPerKm,
    series: {
      speedMps: metrics.map((item) => item.speedMps),
      heartRate: metrics.map((item) => item.averageHeartRate).filter((value) => value > 0),
      relativeEffort: metrics.map((item) => item.relativeEffortScore).filter((value) => value > 0),
      elevationPerKm: metrics.map((item) => item.elevationPerKm),
      trainingLoad: metrics.map((item) => item.trainingLoad),
      distanceKm: metrics.map((item) => item.distanceKm),
      durationMinutes: metrics.map((item) => item.durationMinutes),
      paceDeviationRatio
    },
    weekly: {
      distanceKm: weeklyDistance,
      movingHours: weeklyMovingHours,
      longRunKm: weeklyLongRun,
      avgSpeedMps: weeklySpeed,
      elevationDensity: weeklyElevationDensity,
      trailSessions: weeklyTrailSessions,
      activeDays: weeklyActiveDays,
      distanceVariation: rollingDistanceVariation,
      distanceMedian: median(weeklyDistance),
      longRunMedian: median(weeklyLongRun)
    }
  };
}

function computeIntensityDistribution(activities, baseline) {
  const list = Array.isArray(activities) ? activities : [];
  if (list.length === 0) {
    return {
      easyPct: 0,
      moderatePct: 0,
      hardPct: 0,
      sampleCount: 0
    };
  }

  let easy = 0;
  let moderate = 0;
  let hard = 0;

  for (const item of list) {
    const score = buildActivityAnalysis(item, { baseline }).intensityScore;
    if (score < 45) {
      easy += 1;
    } else if (score < 70) {
      moderate += 1;
    } else {
      hard += 1;
    }
  }

  const total = list.length;
  return {
    easyPct: Math.round((easy / total) * 100),
    moderatePct: Math.round((moderate / total) * 100),
    hardPct: Math.round((hard / total) * 100),
    sampleCount: total
  };
}

function buildTrainingLoadBalance({ acuteLoad, chronicLoad, analysis }) {
  const acute = Number(analysis?.load?.acuteLoad7d ?? acuteLoad ?? 0);
  const chronic = Number(analysis?.load?.chronicLoad28d ?? chronicLoad ?? 0);
  const ratio = chronic > 0 ? acute / chronic : 0;

  let zone = 'Insuffisante';
  let advice = 'Charge faible: ajoute progressivement du volume facile.';
  let riskScore = 20;

  if (ratio >= 0.8 && ratio <= 1.3) {
    zone = 'Optimale';
    advice = 'Charge bien calibree: tu peux maintenir ce rythme.';
    riskScore = 35;
  } else if (ratio > 1.3 && ratio <= 1.5) {
    zone = 'Elevee';
    advice = 'Charge en hausse: garde une seule seance intense et optimise la recup.';
    riskScore = 62;
  } else if (ratio > 1.5) {
    zone = 'Risque';
    advice = 'Risque de surcharge: baisse volume/intensite 48-72h.';
    riskScore = 82;
  }

  return {
    acuteLoad7d: round1(acute),
    chronicLoad28d: round1(chronic),
    ratio: round2(ratio),
    zone,
    riskScore,
    advice
  };
}

function buildWeeklyTarget({ weekDistanceKm, trendWeeks, weeklyBaseline }) {
  const baselineTarget = Number(weeklyBaseline?.distanceMedian ?? 0);
  const trailingWeeks = Array.isArray(trendWeeks) ? trendWeeks.slice(-4, -1) : [];
  const trailingAvg = trailingWeeks.length > 0
    ? sum(trailingWeeks, (item) => Number(item.distanceKm ?? 0)) / trailingWeeks.length
    : 0;

  const targetDistanceKm = round1(Math.max(12, baselineTarget, trailingAvg));
  const remainingDistanceKm = round1(Math.max(targetDistanceKm - weekDistanceKm, 0));
  const progressPct = targetDistanceKm > 0
    ? Math.min(100, Math.round((weekDistanceKm / targetDistanceKm) * 100))
    : 0;

  const weekRatio = weekElapsedRatio();
  const projectedDistanceKm = weekRatio > 0
    ? round1(weekDistanceKm / weekRatio)
    : weekDistanceKm;
  const onTrack = projectedDistanceKm >= targetDistanceKm * 0.95;

  return {
    targetDistanceKm,
    currentDistanceKm: round1(weekDistanceKm),
    remainingDistanceKm,
    progressPct,
    projectedDistanceKm,
    onTrack
  };
}

function buildConsistencySnapshot({ currentWeek, trendWeeks, weeklyBaseline }) {
  const activeDaysThisWeek = countActiveDays(currentWeek);
  const baselineActiveDays = Math.max(1, Math.round(median(weeklyBaseline?.activeDays ?? [])));
  const streakWeeks3PlusRuns = countTrailingWeeks(
    trendWeeks,
    (week) => Number(week.distanceKm ?? 0) > 0 && Number(week.activeDays ?? 0) >= 3
  );

  return {
    activeDaysThisWeek,
    baselineActiveDays,
    streakWeeks3PlusRuns
  };
}

function countTrailingWeeks(weeks, predicate) {
  if (!Array.isArray(weeks) || weeks.length === 0) {
    return 0;
  }
  let count = 0;
  for (let i = weeks.length - 1; i >= 0; i -= 1) {
    if (!predicate(weeks[i])) {
      break;
    }
    count += 1;
  }
  return count;
}

function weekElapsedRatio() {
  const now = new Date();
  const day = now.getDay() === 0 ? 7 : now.getDay();
  const secondsToday =
    (now.getHours() * 3600) +
    (now.getMinutes() * 60) +
    now.getSeconds();
  const elapsed = ((day - 1) * 24 * 3600) + secondsToday;
  const weekTotal = 7 * 24 * 3600;
  return Math.max(0.05, Math.min(1, elapsed / weekTotal));
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

function paceToSpeedMps(paceMinKm) {
  if (!paceMinKm || paceMinKm <= 0) {
    return 0;
  }
  return 1000 / (paceMinKm * 60);
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
  trailReadinessIndex,
  loadRatio
}) {
  if (fatigueZone === 'Rouge' || fatigueScore >= 75 || loadRatio >= 1.45) {
    const subtitle = fatigueScore >= 85 || loadRatio >= 1.55
      ? '72h faciles: 2 footings Z1-Z2 + 1 repos complet. Reprise qualite ensuite.'
      : '48h legeres: reduis volume de 30% et garde uniquement de l endurance facile.';
    return {
      focusTitle: 'Focus recuperation active',
      focusSubtitle: subtitle
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
          ? 'Priorite: consolider endurance et capacite en montee (1 sortie vallonnee + 1 sortie longue).'
          : 'Priorite: stabiliser le rythme hebdo avec 3-4 sorties constantes.'
      };
  }
}

function computeWeeklyComparisons(weeks, previousCount = 3) {
  const clean = Array.isArray(weeks) ? weeks : [];
  if (clean.length === 0) {
    return {
      speedDeltaPct: 0,
      volumeDeltaPct: 0,
      elevationDeltaPct: 0
    };
  }

  const current = clean[clean.length - 1];
  const previousSlice = clean.slice(
    Math.max(0, clean.length - (previousCount + 1)),
    clean.length - 1
  );

  const previousAvg = averageWeeklyBucket(previousSlice);
  return {
    speedDeltaPct: round1(percentDeltaOrZero(current.avgSpeedMps, previousAvg.avgSpeedMps)),
    volumeDeltaPct: round1(percentDeltaOrZero(current.distanceKm, previousAvg.distanceKm)),
    elevationDeltaPct: round1(percentDeltaOrZero(current.elevationM, previousAvg.elevationM))
  };
}

function averageWeeklyBucket(weeks) {
  if (!Array.isArray(weeks) || weeks.length === 0) {
    return {
      avgSpeedMps: 0,
      distanceKm: 0,
      elevationM: 0
    };
  }

  return {
    avgSpeedMps: sum(weeks, (item) => Number(item.avgSpeedMps ?? 0)) / weeks.length,
    distanceKm: sum(weeks, (item) => Number(item.distanceKm ?? 0)) / weeks.length,
    elevationM: sum(weeks, (item) => Number(item.elevationM ?? 0)) / weeks.length
  };
}

function percentDeltaOrZero(value, baseline) {
  const delta = percentDelta(value, baseline);
  return Number.isFinite(delta) ? delta : 0;
}

function formatSignedPct(value) {
  if (!Number.isFinite(value)) {
    return '0%';
  }
  const rounded = round1(value);
  if (rounded > 0) {
    return `+${rounded}%`;
  }
  return `${rounded}%`;
}

function computeActivityMetrics(activity) {
  const distanceKm = Number(activity.distanceM ?? 0) / 1000;
  const movingTimeSec = Number(activity.movingTimeSec ?? 0);
  const durationMinutes = movingTimeSec / 60;
  const paceMinPerKm = computePaceMinPerKm(activity);
  const speedMps = movingTimeSec > 0 ? Number(activity.distanceM ?? 0) / movingTimeSec : 0;
  const averageHeartRate = Number(activity.averageHeartRate ?? 0);
  const relativeEffortScore = Number(activity.relativeEffortScore ?? 0);
  const elevationGain = Number(activity.totalElevationGainM ?? 0);
  const elevationPerKmValue = elevationPerKm(activity);
  const hrRatio = averageHeartRate > 0 ? Math.min(1.08, averageHeartRate / 190) : 0.65;
  const relativeEffortLoad = relativeEffortScore > 0 ? (relativeEffortScore * 0.8) : 0;
  const trainingLoad = (durationMinutes * (1 + hrRatio * 1.9)) + (elevationGain / 85) + relativeEffortLoad;

  return {
    distanceKm,
    durationMinutes,
    paceMinPerKm,
    speedMps,
    averageHeartRate,
    relativeEffortScore: relativeEffortScore > 0 ? relativeEffortScore : 0,
    elevationGain,
    elevationPerKm: elevationPerKmValue,
    trainingLoad
  };
}

function weightedScore(entries) {
  const valid = entries.filter((entry) => Number.isFinite(entry.score) && entry.weight > 0);
  if (valid.length === 0) {
    return 0;
  }
  const totalWeight = valid.reduce((sum, entry) => sum + entry.weight, 0);
  const weighted = valid.reduce((sum, entry) => sum + (entry.score * entry.weight), 0);
  return clampScore(weighted / totalWeight);
}

function percentileScore(series, value, { higherIsBetter = true } = {}) {
  const clean = (Array.isArray(series) ? series : [])
    .filter((item) => Number.isFinite(item))
    .sort((a, b) => a - b);

  if (!Number.isFinite(value) || clean.length === 0) {
    return 50;
  }

  if (clean.length < 5) {
    const min = clean[0];
    const max = clean[clean.length - 1];
    if (max <= min) {
      return 50;
    }
    const normalized = (value - min) / (max - min);
    const score = higherIsBetter ? normalized * 100 : (1 - normalized) * 100;
    return clampScore(score);
  }

  let lowerCount = 0;
  let equalCount = 0;
  for (const item of clean) {
    if (item < value) {
      lowerCount += 1;
    } else if (item === value) {
      equalCount += 1;
    }
  }

  const rank = (lowerCount + (equalCount * 0.5)) / clean.length;
  const score = higherIsBetter ? rank * 100 : (1 - rank) * 100;
  return clampScore(score);
}

function median(values) {
  const clean = (Array.isArray(values) ? values : [])
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (clean.length === 0) {
    return 0;
  }
  const middle = Math.floor(clean.length / 2);
  if (clean.length % 2 === 0) {
    return (clean[middle - 1] + clean[middle]) / 2;
  }
  return clean[middle];
}

function percentDelta(value, baseline) {
  if (!Number.isFinite(value) || !Number.isFinite(baseline) || baseline <= 0) {
    return null;
  }
  return ((value - baseline) / baseline) * 100;
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
  pickWidgets,
  buildUserBaseline
};
