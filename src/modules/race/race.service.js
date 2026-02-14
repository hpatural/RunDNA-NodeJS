const SUPPORTED_STRAVA_SPORTS = ['Run', 'TrailRun'];

class RaceService {
  constructor({ stravaRepository }) {
    this.stravaRepository = stravaRepository;
  }

  async buildPlan(userId, input = {}) {
    const locale = normalizeLocale(input.locale);
    const raceContext = buildRaceContext(input);
    const athlete = await this.#buildAthleteBaseline(userId, input);
    const profile = this.#buildCourseProfile(input);
    const baseSegments = this.#buildSegments(profile, athlete, locale, raceContext);
    const segments = this.#attachEnergyAndFuelTargets(baseSegments, athlete, raceContext);
    const hydration = this.#buildHydrationPlan(segments, athlete, locale);
    const nutrition = this.#buildNutritionPlan(segments, athlete, locale);
    const pacing = this.#buildPacingGuidance(segments, athlete, locale);
    const aidStations = this.#buildAidStations(profile, segments, athlete, locale);
    const totalCaloriesKcal = Math.round(sum(segments, (s) => Number(s.caloriesKcal ?? 0)));
    const totalCarbTargetG = Math.round(sum(segments, (s) => Number(s.carbTargetG ?? 0)));
    const totalHydrationMl = Math.round(sum(segments, (s) => Number(s.hydrationTargetMl ?? 0)));

    return {
      source: profile.source,
      athlete,
      summary: {
        distanceKm: round2(profile.distanceKm),
        elevationGainM: Math.round(profile.elevationGainM),
        estimatedDurationMin: Math.round(sum(segments, (s) => s.estimatedDurationMin)),
        averageTargetPaceMinPerKm: round2(
          weightedAverage(
            segments.map((s) => ({ value: s.targetPaceMinPerKm, weight: s.distanceKm }))
          )
        ),
        totalCaloriesKcal,
        totalCarbTargetG,
        totalHydrationMl,
        runnerType: athlete.runnerType,
        distancePenaltyPct: round2(
          estimateDistancePenaltyPct({
            raceDistanceKm: profile.distanceKm,
            enduranceScore: athlete.enduranceScore
          })
        ),
        confidenceScore: computePlanConfidence({
          hasGpx: profile.source === 'gpx',
          activitiesSampleCount: athlete.activitiesSampleCount,
          hasWeight: Number.isFinite(Number(input?.weightKg)),
          hasWeather: Number.isFinite(Number(input?.temperatureC)) || Number.isFinite(Number(input?.humidityPct))
        }),
      },
      context: raceContext,
      pacing,
      hydration,
      nutrition,
      aidStations,
      segments,
      generatedAt: new Date().toISOString(),
    };
  }

  async #buildAthleteBaseline(userId, input) {
    const startDate = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();
    const activities = await this.stravaRepository.getActivities(userId, {
      startDate,
      limit: 3000,
      sportTypes: SUPPORTED_STRAVA_SPORTS,
    });

    const valid = activities.filter(
      (item) => Number(item.distanceM ?? 0) > 0 && Number(item.movingTimeSec ?? 0) > 0
    );

    if (valid.length === 0) {
      return {
        level: 'beginner',
        baselinePaceMinPerKm: 6.5,
        weeklyDistanceKm: 20,
        weeklyElevationGainM: 250,
      };
    }

    const paceSeries = valid
      .map((item) => Number(item.movingTimeSec) / 60 / (Number(item.distanceM) / 1000))
      .filter((value) => Number.isFinite(value) && value > 0);
    const distanceByWeek = groupDistanceByIsoWeek(valid);
    const elevationByWeek = groupElevationByIsoWeek(valid);
    const weeklyDistanceKm = median(distanceByWeek);
    const weeklyElevationGainM = median(elevationByWeek);
    const baselinePaceMinPerKm = median(paceSeries);
    const level = resolveAthleteLevel({ weeklyDistanceKm, baselinePaceMinPerKm });
    const shortPace = median(
      valid
        .filter((item) => Number(item.distanceM ?? 0) / 1000 <= 12)
        .map((item) => Number(item.movingTimeSec) / 60 / (Number(item.distanceM) / 1000))
        .filter((value) => Number.isFinite(value) && value > 0)
    ) || baselinePaceMinPerKm;
    const longPace = median(
      valid
        .filter((item) => Number(item.distanceM ?? 0) / 1000 >= 22)
        .map((item) => Number(item.movingTimeSec) / 60 / (Number(item.distanceM) / 1000))
        .filter((value) => Number.isFinite(value) && value > 0)
    ) || baselinePaceMinPerKm * 1.07;
    const enduranceDecayRatio = longPace > 0 && shortPace > 0 ? longPace / shortPace : 1.08;
    const enduranceScore = computeEnduranceScore({
      weeklyDistanceKm,
      decayRatio: enduranceDecayRatio,
      longRunCount: valid.filter((item) => Number(item.distanceM ?? 0) / 1000 >= 18).length
    });
    const speedScore = computeSpeedScore({
      shortPace,
      baselinePace: baselinePaceMinPerKm
    });
    const runnerType = resolveRunnerType({ enduranceScore, speedScore });
    const estimatedWeightKg = resolveAthleteWeightKg({
      explicitWeightKg: input?.weightKg,
      level,
      weeklyDistanceKm,
      baselinePaceMinPerKm
    });

    return {
      level,
      baselinePaceMinPerKm: round2(baselinePaceMinPerKm),
      weeklyDistanceKm: round2(weeklyDistanceKm),
      weeklyElevationGainM: Math.round(weeklyElevationGainM),
      shortPaceMinPerKm: round2(shortPace),
      longPaceMinPerKm: round2(longPace),
      enduranceScore,
      speedScore,
      enduranceDecayRatio: round3(enduranceDecayRatio),
      runnerType,
      estimatedWeightKg: round1(estimatedWeightKg),
      activitiesSampleCount: valid.length,
    };
  }

  #buildCourseProfile(input) {
    const mode = String(input.mode ?? '').toLowerCase();
    if (mode !== 'gpx' && mode !== 'distance') {
      const error = new Error('mode must be "gpx" or "distance"');
      error.statusCode = 400;
      throw error;
    }

    if (mode === 'distance') {
      const distanceKm = Number(input.distanceKm);
      const elevationGainM = Number(input.elevationGainM ?? 0);
      if (!Number.isFinite(distanceKm) || distanceKm <= 0) {
        const error = new Error('distanceKm must be > 0');
        error.statusCode = 400;
        throw error;
      }
      return {
        source: 'distance',
        distanceKm,
        elevationGainM: Math.max(0, elevationGainM),
        points: [],
      };
    }

    const gpx = String(input.gpx ?? '');
    if (!gpx.trim()) {
      const error = new Error('gpx payload is required when mode="gpx"');
      error.statusCode = 400;
      throw error;
    }
    const points = parseGpxTrackPoints(gpx);
    if (points.length < 2) {
      const error = new Error('Invalid GPX: no usable track points');
      error.statusCode = 400;
      throw error;
    }
    const profile = computeProfileFromPoints(points);
    return {
      source: 'gpx',
      distanceKm: profile.distanceKm,
      elevationGainM: profile.elevationGainM,
      points: profile.points,
    };
  }

  #buildSegments(profile, athlete, locale, raceContext) {
    const bounds = buildAdaptiveSegmentBounds(profile);
    const synthetic = profile.points.length > 1
      ? null
      : buildSyntheticElevationAllocations(bounds, profile.elevationGainM);
    const segments = [];
    const segmentCount = bounds.length;
    for (let index = 0; index < bounds.length; index += 1) {
      const { startKm, endKm } = bounds[index];
      const distanceKm = Math.max(0, endKm - startKm);
      const elevationStats = profile.points.length > 1
        ? elevationStatsOnInterval(profile.points, startKm, endKm)
        : {
            gainM: synthetic?.gainByIndex[index] ?? 0,
            lossM: synthetic?.lossByIndex[index] ?? 0
          };
      const gradePct = distanceKm > 0
        ? ((elevationStats.gainM - elevationStats.lossM) / (distanceKm * 1000)) * 100
        : 0;
      const terrain = resolveTerrain(gradePct);
      const midKm = startKm + (distanceKm / 2);
      const progressRatio = profile.distanceKm > 0 ? midKm / profile.distanceKm : 0;
      const targetPaceMinPerKm = targetPaceForSegment({
        athlete,
        raceDistanceKm: profile.distanceKm,
        progressRatio,
        gradePct,
        raceContext,
      });
      const estimatedDurationMin = targetPaceMinPerKm * distanceKm;
      const effort = resolveEffort(gradePct, athlete.level);
      segments.push({
        index: index + 1,
        startKm: round2(startKm),
        endKm: round2(endKm),
        distanceKm: round2(distanceKm),
        elevationGainM: Math.round(elevationStats.gainM),
        elevationLossM: Math.round(elevationStats.lossM),
        avgGradePct: round2(gradePct),
        targetPaceMinPerKm: round2(targetPaceMinPerKm),
        targetPaceLabel: formatPace(targetPaceMinPerKm),
        estimatedDurationMin: Math.round(estimatedDurationMin),
        effort,
        terrain,
        strategy: strategyForSegment({ index, segmentCount, gradePct, locale }),
      });
    }
    return segments;
  }

  #attachEnergyAndFuelTargets(segments, athlete, raceContext) {
    const carbCapPerHour = athlete.level === 'advanced' ? 90 : athlete.level === 'intermediate' ? 75 : 60;
    const enriched = [];
    let minuteCursor = 0;
    for (const segment of segments) {
      const durationMin = Math.max(1, Number(segment.estimatedDurationMin ?? 0));
      const durationHr = durationMin / 60;
      const met = metForSegment(segment);
      const weatherEnergyFactor = 1 + (Math.max(0, raceContext.temperatureC - 16) * 0.0035);
      const caloriesKcal = met * athlete.estimatedWeightKg * durationHr * weatherEnergyFactor;
      const carbOxidationRatio = 0.45 + ((Math.max(1, Math.min(10, segment.effort)) - 1) / 9) * 0.35;
      const carbBurnG = (caloriesKcal * carbOxidationRatio) / 4;
      const carbTargetG = Math.min(
        carbBurnG * 0.82,
        carbCapPerHour * durationHr
      );
      const climbDensity = segment.distanceKm > 0
        ? Math.max(0, Number(segment.elevationGainM ?? 0) / segment.distanceKm)
        : 0;
      const hydrationRateMlPerHour = clamp(
        420 +
          (segment.effort * 30) +
          (climbDensity * 0.9) +
          (Math.max(0, raceContext.temperatureC - 14) * 12) +
          (Math.max(0, raceContext.humidityPct - 50) * 2.1),
        450,
        1250
      );
      const hydrationTargetMl = hydrationRateMlPerHour * durationHr;
      const startMinute = minuteCursor;
      const endMinute = minuteCursor + durationMin;
      minuteCursor = endMinute;

      enriched.push({
        ...segment,
        caloriesKcal: Math.round(caloriesKcal),
        carbBurnG: round1(carbBurnG),
        carbTargetG: round1(carbTargetG),
        hydrationRateMlPerHour: Math.round(hydrationRateMlPerHour),
        hydrationTargetMl: Math.round(hydrationTargetMl),
        startMinute: round1(startMinute),
        endMinute: round1(endMinute),
      });
    }
    return enriched;
  }

  #buildHydrationPlan(segments, athlete, locale) {
    const totalMl = Math.round(sum(segments, (segment) => Number(segment.hydrationTargetMl ?? 0)));
    const totalHours = Math.max(0.01, sum(segments, (segment) => Number(segment.estimatedDurationMin ?? 0)) / 60);
    const averageRate = totalMl / totalHours;
    const minRate = Math.min(...segments.map((segment) => Number(segment.hydrationRateMlPerHour ?? averageRate)));
    const maxRate = Math.max(...segments.map((segment) => Number(segment.hydrationRateMlPerHour ?? averageRate)));
    const stops = [];
    const intervalMin = athlete.level === 'advanced' ? 18 : athlete.level === 'intermediate' ? 20 : 22;
    const totalDurationMin = sum(segments, (segment) => Number(segment.estimatedDurationMin ?? 0));
    let nextStopAtMin = intervalMin;
    let previousStopMin = 0;
    while (nextStopAtMin <= totalDurationMin + 0.1) {
      const atKm = kmAtMinute(segments, nextStopAtMin);
      const hydrationMl = Math.round(amountBetweenMinutes(segments, previousStopMin, nextStopAtMin, 'hydrationRateMlPerHour') / 10) * 10;
      const carbsG = Math.round(amountBetweenMinutes(segments, previousStopMin, nextStopAtMin, 'carbRateGPerHour'));
      stops.push({
        atKm: round2(atKm),
        hydrationMl,
        carbsG,
        action: `${hydrationMl} ml`,
      });
      previousStopMin = nextStopAtMin;
      nextStopAtMin += intervalMin;
    }

    return {
      totalMl,
      guideline: formatHydrationGuideline(locale, Math.round(averageRate), Math.round(minRate), Math.round(maxRate)),
      stops,
    };
  }

  #buildNutritionPlan(segments, athlete, locale) {
    const totalCarbsG = Math.round(sum(segments, (segment) => Number(segment.carbTargetG ?? 0)));
    const totalHours = Math.max(0.01, sum(segments, (segment) => Number(segment.estimatedDurationMin ?? 0)) / 60);
    const avgCarbsPerHour = totalCarbsG / totalHours;
    const carbCapPerHour = athlete.level === 'advanced' ? 90 : athlete.level === 'intermediate' ? 75 : 60;
    const feeds = [];
    const intervalMin = athlete.level === 'advanced' ? 24 : athlete.level === 'intermediate' ? 26 : 30;
    const totalDurationMin = sum(segments, (segment) => Number(segment.estimatedDurationMin ?? 0));
    let nextFeedAtMin = intervalMin;
    let previousFeedMin = 0;
    while (nextFeedAtMin <= totalDurationMin + 0.1) {
      const atKm = kmAtMinute(segments, nextFeedAtMin);
      const carbsG = Math.max(
        athlete.level === 'advanced' ? 20 : 16,
        Math.round(amountBetweenMinutes(segments, previousFeedMin, nextFeedAtMin, 'carbRateGPerHour'))
      );
      feeds.push({
        atKm: round2(atKm),
        carbsG,
        type: locale === 'fr' ? 'gel/boisson glucidique' : 'gel/drink mix',
      });
      previousFeedMin = nextFeedAtMin;
      nextFeedAtMin += intervalMin;
    }

    return {
      totalCarbsG,
      guideline: formatNutritionGuideline(locale, round1(avgCarbsPerHour), carbCapPerHour),
      feeds,
    };
  }

  #buildPacingGuidance(segments, athlete, locale) {
    const distanceKm = sum(segments, (segment) => segment.distanceKm);
    const conservativeUntilKm = round2(distanceKm * 0.15);
    const pushFromKm = round2(distanceKm * (athlete.level === 'advanced' ? 0.72 : 0.82));
    const keySlowZones = segments
      .filter((segment) => segment.avgGradePct >= 4.5)
      .slice(0, 4)
      .map((segment) => ({
        startKm: segment.startKm,
        endKm: segment.endKm,
        reason: t(locale, 'slow_zone_reason'),
      }));
    const keyPushZones = segments
      .filter((segment) => segment.avgGradePct <= 1.2 && segment.endKm >= pushFromKm)
      .slice(0, 4)
      .map((segment) => ({
        startKm: segment.startKm,
        endKm: segment.endKm,
        reason: t(locale, 'push_zone_reason'),
      }));
    const paceByTerrain = buildTerrainPaces(athlete);

    return {
      conservativeUntilKm,
      pushFromKm,
      paceByTerrain,
      keySlowZones,
      keyPushZones,
      notes: [
        t(locale, 'note_start_controlled'),
        t(locale, 'note_keep_fueling'),
        t(locale, 'note_manage_climbs'),
      ],
    };
  }

  #buildAidStations(profile, segments, athlete, locale) {
    const totalDistanceKm = profile.distanceKm;
    if (!Number.isFinite(totalDistanceKm) || totalDistanceKm <= 0) {
      return [];
    }

    const everyKm = totalDistanceKm <= 30 ? 7 : totalDistanceKm <= 55 ? 8 : 10;
    const candidates = [];
    for (let km = everyKm; km < totalDistanceKm; km += everyKm) {
      candidates.push({
        atKm: round2(km),
        reason: t(locale, 'aid_periodic'),
      });
    }

    for (const segment of segments) {
      if (segment.avgGradePct >= 4.5) {
        candidates.push({
          atKm: round2(segment.endKm),
          reason: t(locale, 'aid_top_climb'),
        });
      }
    }

    if (profile.points.length > 2) {
      const peaks = detectLocalPeaks(profile.points, totalDistanceKm);
      for (const peak of peaks) {
        candidates.push({
          atKm: peak.atKm,
          reason: t(locale, 'aid_terrain_high'),
        });
      }
    }

    const deduped = dedupeStations(
      candidates
        .filter((item) => item.atKm >= 2 && item.atKm <= totalDistanceKm - 1)
        .sort((a, b) => a.atKm - b.atKm),
      1.4
    ).slice(0, 14);

    let previousMinute = 0;
    return deduped.map((item) => {
      const currentMinute = minuteAtKm(segments, item.atKm);
      const hydrationMl = Math.round(amountBetweenMinutes(segments, previousMinute, currentMinute, 'hydrationRateMlPerHour') / 10) * 10;
      const carbsG = Math.round(amountBetweenMinutes(segments, previousMinute, currentMinute, 'carbRateGPerHour'));
      previousMinute = currentMinute;
      return {
        atKm: item.atKm,
        reason: item.reason,
        hydrationMl: Math.max(120, hydrationMl),
        carbsG: Math.max(15, carbsG),
      };
    });
  }
}

function normalizeLocale(raw) {
  const value = String(raw ?? '').toLowerCase();
  return value.startsWith('fr') ? 'fr' : 'en';
}

function t(locale, key) {
  const dict = locale === 'fr'
    ? {
        slow_zone_reason: "Montee raide: protege la frequence cardiaque et raccourcis la foulee.",
        push_zone_reason: 'Section roulante: acceleration progressive possible.',
        note_start_controlled: 'Depart controle sur les 15% initiaux pour preserver le glycogene.',
        note_keep_fueling: "Hydrate-toi et mange avant d'avoir un coup de mou.",
        note_manage_climbs: "Utilise les montees pour gerer l'effort, pas pour chasser l'allure.",
        aid_periodic: 'Ravito periodique',
        aid_top_climb: 'Transition en haut de montee',
        aid_terrain_high: 'Point haut naturel du terrain',
      }
    : {
        slow_zone_reason: 'Steep climb: protect heart rate and shorten stride.',
        push_zone_reason: 'Runnable section: progressive acceleration possible.',
        note_start_controlled: 'Start controlled for the first 15% to preserve glycogen.',
        note_keep_fueling: 'Keep fueling before you feel empty.',
        note_manage_climbs: 'Use climbs to manage effort, not to chase pace.',
        aid_periodic: 'Periodic refill point',
        aid_top_climb: 'Top of climb transition',
        aid_terrain_high: 'Natural terrain high point',
      };
  return dict[key] ?? key;
}

function formatHydrationGuideline(locale, mlPerHour) {
  const avg = arguments[1];
  const min = arguments[2] ?? avg;
  const max = arguments[3] ?? avg;
  return locale === 'fr'
    ? `${avg} ml/h moyenne (${min}-${max})`
    : `${avg} ml/h average (${min}-${max})`;
}

function formatNutritionGuideline(locale, carbsPerHour, capPerHour) {
  return locale === 'fr'
    ? `${carbsPerHour} g glucides/h (cap ${capPerHour} g/h)`
    : `${carbsPerHour} g carbs/h (cap ${capPerHour} g/h)`;
}

function parseGpxTrackPoints(gpx) {
  const points = [];
  const regex = /<trkpt[^>]*lat="([^"]+)"[^>]*lon="([^"]+)"[^>]*>([\s\S]*?)<\/trkpt>/gi;
  let match;
  while ((match = regex.exec(gpx)) !== null) {
    const lat = Number(match[1]);
    const lon = Number(match[2]);
    const body = match[3] ?? '';
    const eleMatch = body.match(/<ele>([^<]+)<\/ele>/i);
    const ele = eleMatch ? Number(eleMatch[1]) : null;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      continue;
    }
    points.push({ lat, lon, ele: Number.isFinite(ele) ? ele : null });
  }
  return points;
}

function computeProfileFromPoints(points) {
  let distanceM = 0;
  let elevationGainM = 0;
  let cumulativeKm = 0;
  const enriched = [{ ...points[0], cumulativeKm: 0 }];
  for (let index = 1; index < points.length; index += 1) {
    const prev = points[index - 1];
    const next = points[index];
    const delta = haversineMeters(prev.lat, prev.lon, next.lat, next.lon);
    distanceM += delta;
    cumulativeKm += delta / 1000;
    if (Number.isFinite(prev.ele) && Number.isFinite(next.ele) && next.ele > prev.ele) {
      elevationGainM += next.ele - prev.ele;
    }
    enriched.push({ ...next, cumulativeKm: round4(cumulativeKm) });
  }
  return {
    distanceKm: distanceM / 1000,
    elevationGainM,
    points: enriched,
  };
}

function gainOnInterval(points, startKm, endKm) {
  return elevationStatsOnInterval(points, startKm, endKm).gainM;
}

function elevationStatsOnInterval(points, startKm, endKm) {
  if (points.length < 2 || endKm <= startKm) {
    return { gainM: 0, lossM: 0 };
  }
  let gain = 0;
  let loss = 0;
  for (let index = 1; index < points.length; index += 1) {
    const prev = points[index - 1];
    const curr = points[index];
    const prevKm = Number(prev.cumulativeKm ?? 0);
    const currKm = Number(curr.cumulativeKm ?? 0);
    const edgeKm = Math.max(0.00001, currKm - prevKm);
    const overlapStart = Math.max(startKm, prevKm);
    const overlapEnd = Math.min(endKm, currKm);
    const overlapKm = Math.max(0, overlapEnd - overlapStart);
    if (overlapKm <= 0) {
      continue;
    }
    if (Number.isFinite(prev.ele) && Number.isFinite(curr.ele)) {
      const delta = (curr.ele - prev.ele) * (overlapKm / edgeKm);
      if (delta > 0) {
        gain += delta;
      } else {
        loss += Math.abs(delta);
      }
    }
  }
  return { gainM: gain, lossM: loss };
}

function groupDistanceByIsoWeek(activities) {
  const buckets = new Map();
  for (const item of activities) {
    const date = new Date(item.startDate);
    const key = isoWeekKey(date);
    const distanceKm = Number(item.distanceM ?? 0) / 1000;
    buckets.set(key, (buckets.get(key) ?? 0) + distanceKm);
  }
  return Array.from(buckets.values()).filter((value) => value > 0);
}

function groupElevationByIsoWeek(activities) {
  const buckets = new Map();
  for (const item of activities) {
    const date = new Date(item.startDate);
    const key = isoWeekKey(date);
    const gain = Number(item.totalElevationGainM ?? 0);
    buckets.set(key, (buckets.get(key) ?? 0) + gain);
  }
  return Array.from(buckets.values()).filter((value) => value >= 0);
}

function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-${String(weekNo).padStart(2, '0')}`;
}

function resolveAthleteLevel({ weeklyDistanceKm, baselinePaceMinPerKm }) {
  if (weeklyDistanceKm >= 60 || baselinePaceMinPerKm <= 4.9) {
    return 'advanced';
  }
  if (weeklyDistanceKm >= 30 || baselinePaceMinPerKm <= 5.8) {
    return 'intermediate';
  }
  return 'beginner';
}

function resolveTerrain(gradePct) {
  if (gradePct >= 2.8) {
    return 'climb';
  }
  if (gradePct <= -2) {
    return 'downhill';
  }
  return 'flat';
}

function targetPaceForSegment({ athlete, raceDistanceKm, progressRatio, gradePct }) {
  const profile = athlete ?? {};
  const distanceKm = Number(raceDistanceKm ?? 10);
  const raceProgress = clamp01(Number(progressRatio ?? 0));
  const basePace = Number(profile.baselinePaceMinPerKm ?? 6);
  const level = profile.level ?? 'intermediate';
  const paceFactor = paceFactorFromGrade(gradePct);
  const levelFactor = level === 'advanced' ? 0.96 : level === 'intermediate' ? 1 : 1.05;
  const enduranceScore = Number(profile.enduranceScore ?? 55);
  const speedScore = Number(profile.speedScore ?? 55);
  const decayRatio = Number(profile.enduranceDecayRatio ?? 1.08);

  // Distance penalty: half marathon / marathon should not use 10k pace.
  const distanceLog = Math.log1p(Math.max(0, distanceKm - 10)) / Math.log1p(32);
  const distancePenaltyPct = estimateDistancePenaltyPct({
    raceDistanceKm: distanceKm,
    enduranceScore
  });
  const distanceFactor = 1 + (distancePenaltyPct / 100);

  // Cardiac drift / fatigue rises with distance and is reduced by endurance profile.
  const driftBase = 0.01 + Math.max(0, (distanceKm - 18) / 240);
  const driftFactor = 1 + (driftBase * raceProgress * (1.25 - enduranceScore / 100));

  // Phase pacing curve: conservative start, controlled middle, late behavior by profile.
  const startConservative = raceProgress < 0.12
    ? 1 + (0.025 + (distanceKm > 25 ? 0.02 : 0.01))
    : 1;
  const lateRacePenalty = raceProgress > 0.72
    ? 1 + ((raceProgress - 0.72) * (decayRatio - 1) * 1.25)
    : 1;
  const lateRaceBonus = raceProgress > 0.82 && speedScore > enduranceScore + 8
    ? 1 - ((raceProgress - 0.82) * 0.035)
    : 1;

  const terrain = resolveTerrain(gradePct);
  const terrainFactor = terrain === 'climb'
    ? (level === 'advanced' ? 1.14 : level === 'intermediate' ? 1.18 : 1.24)
    : terrain === 'downhill'
      ? (level === 'advanced' ? 0.9 : level === 'intermediate' ? 0.93 : 0.96)
      : 1;
  const raceContext = arguments[0].raceContext ?? buildRaceContext({});
  const heatPacePenalty = 1 + (Math.max(0, raceContext.temperatureC - 14) * 0.003);
  const humidityPacePenalty = 1 + (Math.max(0, raceContext.humidityPct - 55) * 0.0014);

  return basePace
    * paceFactor
    * levelFactor
    * terrainFactor
    * distanceFactor
    * driftFactor
    * startConservative
    * lateRacePenalty
    * lateRaceBonus
    * heatPacePenalty
    * humidityPacePenalty;
}

function estimateDistancePenaltyPct({ raceDistanceKm, enduranceScore }) {
  const distanceKm = Number(raceDistanceKm ?? 10);
  const score = Number(enduranceScore ?? 55);
  const distanceLog = Math.log1p(Math.max(0, distanceKm - 10)) / Math.log1p(32);
  const distancePenaltyMax = 0.16 - ((score - 50) / 1000);
  return distancePenaltyMax * distanceLog * 100;
}

function buildTerrainPaces(athlete) {
  const baseline = Number(athlete.baselinePaceMinPerKm ?? 0) || 6;
  const levelFactor = athlete.level === 'advanced' ? 0.96 : athlete.level === 'intermediate' ? 1 : 1.05;
  const flat = baseline * levelFactor;
  const climb = flat * (athlete.level === 'advanced' ? 1.18 : athlete.level === 'intermediate' ? 1.23 : 1.28);
  const downhill = flat * (athlete.level === 'advanced' ? 0.9 : athlete.level === 'intermediate' ? 0.93 : 0.96);
  return {
    climbPaceLabel: formatPace(climb),
    flatPaceLabel: formatPace(flat),
    downhillPaceLabel: formatPace(downhill),
  };
}

function computeEnduranceScore({ weeklyDistanceKm, decayRatio, longRunCount }) {
  const volumeScore = clamp((weeklyDistanceKm / 80) * 100, 0, 100);
  const decayScore = clamp((1.22 - decayRatio) * 330, 0, 100);
  const longRunScore = clamp(longRunCount * 6, 0, 100);
  return Math.round((volumeScore * 0.5) + (decayScore * 0.35) + (longRunScore * 0.15));
}

function computeSpeedScore({ shortPace, baselinePace }) {
  if (shortPace <= 0 || baselinePace <= 0) {
    return 50;
  }
  const reserve = baselinePace / shortPace;
  return Math.round(clamp((reserve - 1) * 180, 0, 100));
}

function resolveRunnerType({ enduranceScore, speedScore }) {
  if (enduranceScore >= speedScore + 12) {
    return 'endurance';
  }
  if (speedScore >= enduranceScore + 12) {
    return 'speed';
  }
  return 'balanced';
}

function buildRaceContext(input) {
  const rawTemp = Number(input?.temperatureC);
  const rawHumidity = Number(input?.humidityPct);
  const temperatureC = Number.isFinite(rawTemp) ? clamp(rawTemp, -10, 45) : 18;
  const humidityPct = Number.isFinite(rawHumidity) ? clamp(rawHumidity, 5, 100) : 55;
  return {
    temperatureC: round1(temperatureC),
    humidityPct: round1(humidityPct),
  };
}

function computePlanConfidence({ hasGpx, activitiesSampleCount, hasWeight, hasWeather }) {
  let score = hasGpx ? 62 : 52;
  score += clamp((Number(activitiesSampleCount ?? 0) / 90) * 26, 0, 26);
  if (hasWeight) score += 6;
  if (hasWeather) score += 6;
  return Math.round(clamp(score, 20, 96));
}

function paceFactorFromGrade(gradePct) {
  if (gradePct >= 8) return 1.45;
  if (gradePct >= 6) return 1.32;
  if (gradePct >= 4) return 1.22;
  if (gradePct >= 2) return 1.12;
  if (gradePct <= -6) return 0.86;
  if (gradePct <= -3) return 0.92;
  if (gradePct <= -1) return 0.96;
  return 1.0;
}

function resolveEffort(gradePct, level) {
  const base = gradePct >= 6 ? 8 : gradePct >= 3 ? 7 : gradePct <= -3 ? 5 : 6;
  const levelAdj = level === 'advanced' ? 0 : level === 'intermediate' ? 0.4 : 0.8;
  const value = Math.max(1, Math.min(10, Math.round(base + levelAdj)));
  return value;
}

function strategyForSegment({ index, segmentCount, gradePct, locale }) {
  if (index <= Math.max(1, Math.floor(segmentCount * 0.15))) {
    return locale === 'fr'
      ? 'Depart controle, respiration facile.'
      : 'Controlled start, keep breathing easy.';
  }
  if (gradePct >= 5) {
    return locale === 'fr'
      ? "Gestion de montee: raccourcis la foulee et plafonne l'effort."
      : 'Climb management: shorten stride and cap effort.';
  }
  if (index >= Math.floor(segmentCount * 0.75) && gradePct <= 1.5) {
    return locale === 'fr'
      ? "Acceleration progressive si l'hydratation/nutrition est bien tenue."
      : 'Progressive push if fueling is on track.';
  }
  return locale === 'fr'
    ? 'Execution reguliere et ravitaillement constant.'
    : 'Steady execution and regular fueling.';
}

function effortFactor(effort) {
  return 0.9 + ((Math.max(1, Math.min(10, effort)) - 1) / 9) * 0.3;
}

function metForSegment(segment) {
  const terrain = segment.terrain;
  const effort = Math.max(1, Math.min(10, Number(segment.effort ?? 5)));
  const terrainBase = terrain === 'climb' ? 10.8 : terrain === 'downhill' ? 8.2 : 9.5;
  const effortAdj = 0.35 * (effort - 5);
  return clamp(terrainBase + effortAdj, 6.5, 16.0);
}

function median(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return 0;
  }
  const sorted = [...list].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function weightedAverage(items) {
  const totalWeight = sum(items, (item) => Number(item.weight ?? 0));
  if (!totalWeight) {
    return 0;
  }
  const total = sum(items, (item) => Number(item.value ?? 0) * Number(item.weight ?? 0));
  return total / totalWeight;
}

function detectLocalPeaks(points, totalDistanceKm) {
  const peaks = [];
  for (let index = 1; index < points.length - 1; index += 1) {
    const prev = points[index - 1];
    const curr = points[index];
    const next = points[index + 1];
    if (!Number.isFinite(prev.ele) || !Number.isFinite(curr.ele) || !Number.isFinite(next.ele)) {
      continue;
    }
    if (curr.ele > prev.ele + 8 && curr.ele > next.ele + 8) {
      const atKm = round2(Number(curr.cumulativeKm ?? 0));
      if (atKm > 1.5 && atKm < totalDistanceKm - 1.5) {
        peaks.push({ atKm });
      }
    }
  }
  return peaks.slice(0, 8);
}

function dedupeStations(stations, minGapKm) {
  const out = [];
  for (const station of stations) {
    const last = out[out.length - 1];
    if (!last || station.atKm - last.atKm >= minGapKm) {
      out.push(station);
    }
  }
  return out;
}

function resolveAthleteWeightKg({ explicitWeightKg, level, weeklyDistanceKm, baselinePaceMinPerKm }) {
  const explicit = Number(explicitWeightKg);
  if (Number.isFinite(explicit) && explicit >= 40 && explicit <= 130) {
    return explicit;
  }
  const base = level === 'advanced' ? 68 : level === 'intermediate' ? 72 : 76;
  const volumeAdj = clamp((Number(weeklyDistanceKm ?? 0) - 35) * -0.07, -4, 4);
  const paceAdj = clamp((Number(baselinePaceMinPerKm ?? 6) - 5.5) * 1.6, -3.5, 3.5);
  return clamp(base + volumeAdj + paceAdj, 52, 92);
}

function minuteAtKm(segments, targetKm) {
  let fallback = 0;
  for (const segment of segments) {
    const startKm = Number(segment.startKm ?? 0);
    const endKm = Number(segment.endKm ?? startKm);
    const startMinute = Number(segment.startMinute ?? fallback);
    const endMinute = Number(segment.endMinute ?? startMinute);
    fallback = endMinute;
    if (targetKm >= startKm && targetKm <= endKm && endKm > startKm) {
      const ratio = (targetKm - startKm) / (endKm - startKm);
      return startMinute + (endMinute - startMinute) * ratio;
    }
  }
  return fallback;
}

function kmAtMinute(segments, targetMinute) {
  let fallback = 0;
  for (const segment of segments) {
    const startMinute = Number(segment.startMinute ?? 0);
    const endMinute = Number(segment.endMinute ?? startMinute);
    const startKm = Number(segment.startKm ?? fallback);
    const endKm = Number(segment.endKm ?? startKm);
    fallback = endKm;
    if (targetMinute >= startMinute && targetMinute <= endMinute && endMinute > startMinute) {
      const ratio = (targetMinute - startMinute) / (endMinute - startMinute);
      return startKm + (endKm - startKm) * ratio;
    }
  }
  return fallback;
}

function amountBetweenMinutes(segments, startMinute, endMinute, rateField) {
  if (endMinute <= startMinute) {
    return 0;
  }
  let total = 0;
  for (const segment of segments) {
    const segStart = Number(segment.startMinute ?? 0);
    const segEnd = Number(segment.endMinute ?? segStart);
    const overlapStart = Math.max(startMinute, segStart);
    const overlapEnd = Math.min(endMinute, segEnd);
    const overlapMin = Math.max(0, overlapEnd - overlapStart);
    if (overlapMin <= 0) {
      continue;
    }
    const ratePerHour = rateField === 'carbRateGPerHour'
      ? (Number(segment.carbTargetG ?? 0) / Math.max(0.0001, Number(segment.estimatedDurationMin ?? 1) / 60))
      : Number(segment.hydrationRateMlPerHour ?? 0);
    total += ratePerHour * (overlapMin / 60);
  }
  return total;
}

function buildAdaptiveSegmentBounds(profile) {
  if (profile.points.length > 1) {
    return buildBoundsFromGpx(profile.points, profile.distanceKm);
  }
  return buildBoundsFromDistance(profile.distanceKm, profile.elevationGainM);
}

function buildBoundsFromGpx(points, totalDistanceKm) {
  const bounds = [];
  const minLenKm = 0.9;
  const maxLenKm = totalDistanceKm <= 20 ? 2.1 : totalDistanceKm <= 45 ? 2.8 : 3.6;
  const probeKm = 0.7;
  const stepKm = 0.35;
  let startKm = 0;

  while (startKm < totalDistanceKm - 0.05) {
    const seedStats = elevationStatsOnInterval(
      points,
      startKm,
      Math.min(totalDistanceKm, startKm + probeKm)
    );
    const seedDistance = Math.max(0.2, Math.min(totalDistanceKm - startKm, probeKm));
    const seedGrade = ((seedStats.gainM - seedStats.lossM) / (seedDistance * 1000)) * 100;
    const baseTerrain = resolveTerrain(seedGrade);
    let endKm = Math.min(totalDistanceKm, startKm + minLenKm);

    while (endKm < totalDistanceKm) {
      const nextEnd = Math.min(totalDistanceKm, endKm + stepKm);
      const winStats = elevationStatsOnInterval(points, endKm, Math.min(totalDistanceKm, endKm + probeKm));
      const winDistance = Math.max(0.2, Math.min(totalDistanceKm - endKm, probeKm));
      const winGrade = ((winStats.gainM - winStats.lossM) / (winDistance * 1000)) * 100;
      const winTerrain = resolveTerrain(winGrade);
      const currentLen = endKm - startKm;
      if (currentLen >= minLenKm && winTerrain !== baseTerrain) {
        break;
      }
      if (currentLen >= maxLenKm) {
        break;
      }
      endKm = nextEnd;
    }

    bounds.push({ startKm: round2(startKm), endKm: round2(endKm) });
    startKm = endKm;
  }

  return normalizeBounds(bounds, totalDistanceKm);
}

function buildBoundsFromDistance(totalDistanceKm, elevationGainM) {
  const avgLenKm = totalDistanceKm <= 20 ? 1.8 : totalDistanceKm <= 45 ? 2.5 : 3.2;
  const dplusPerKm = totalDistanceKm > 0 ? elevationGainM / totalDistanceKm : 0;
  const ruggedness = clamp01(dplusPerKm / 55);
  const wave = [0.78, 1.22, 0.92, 1.35, 0.86, 1.12];
  const bounds = [];
  let cursor = 0;
  let idx = 0;

  while (cursor < totalDistanceKm - 0.05) {
    const amp = 1 + ruggedness * 0.35;
    const len = avgLenKm * wave[idx % wave.length] * amp;
    const next = Math.min(totalDistanceKm, cursor + len);
    bounds.push({ startKm: round2(cursor), endKm: round2(next) });
    cursor = next;
    idx += 1;
  }

  return normalizeBounds(bounds, totalDistanceKm);
}

function normalizeBounds(bounds, totalDistanceKm) {
  if (bounds.length === 0) {
    return [{ startKm: 0, endKm: round2(totalDistanceKm) }];
  }
  const out = [];
  let cursor = 0;
  for (const item of bounds) {
    const startKm = round2(Math.max(cursor, Number(item.startKm ?? cursor)));
    const endKm = round2(Math.max(startKm + 0.05, Number(item.endKm ?? startKm + 0.05)));
    out.push({ startKm, endKm: Math.min(endKm, round2(totalDistanceKm)) });
    cursor = out[out.length - 1].endKm;
  }
  out[out.length - 1].endKm = round2(totalDistanceKm);
  return out.filter((item) => item.endKm > item.startKm);
}

function buildSyntheticElevationAllocations(bounds, totalGainM) {
  const gainWeights = bounds.map((_, index) => Math.max(0.2, 0.9 + Math.sin((index + 1) * 1.15)));
  const lossWeights = bounds.map((_, index) => Math.max(0.2, 0.9 + Math.sin((index + 1) * 0.95 + 1.8)));
  const gainWeightSum = sum(gainWeights, (value) => value);
  const lossWeightSum = sum(lossWeights, (value) => value);
  const totalLossM = totalGainM * 0.86;
  const gainByIndex = gainWeights.map((weight) => (weight / gainWeightSum) * totalGainM);
  const lossByIndex = lossWeights.map((weight) => (weight / lossWeightSum) * totalLossM);
  return { gainByIndex, lossByIndex };
}

function clamp01(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const r = 6371000;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function formatPace(paceMinPerKm) {
  if (!Number.isFinite(paceMinPerKm) || paceMinPerKm <= 0) {
    return '0:00/km';
  }
  const minutes = Math.floor(paceMinPerKm);
  const seconds = Math.round((paceMinPerKm - minutes) * 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}/km`;
}

function sum(items, selector) {
  return items.reduce((acc, item) => acc + (Number(selector(item)) || 0), 0);
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function round3(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1000) / 1000;
}

function round1(value) {
  return Math.round((Number(value) + Number.EPSILON) * 10) / 10;
}

function round4(value) {
  return Math.round((Number(value) + Number.EPSILON) * 10000) / 10000;
}

module.exports = { RaceService };
