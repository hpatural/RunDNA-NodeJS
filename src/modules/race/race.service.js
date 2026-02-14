const SUPPORTED_STRAVA_SPORTS = ['Run', 'TrailRun'];

class RaceService {
  constructor({ stravaRepository }) {
    this.stravaRepository = stravaRepository;
  }

  async buildPlan(userId, input = {}) {
    const locale = normalizeLocale(input.locale);
    const athlete = await this.#buildAthleteBaseline(userId);
    const profile = this.#buildCourseProfile(input);
    const segments = this.#buildSegments(profile, athlete, locale);
    const hydration = this.#buildHydrationPlan(segments, athlete, locale);
    const nutrition = this.#buildNutritionPlan(segments, athlete, locale);
    const pacing = this.#buildPacingGuidance(segments, athlete, locale);
    const aidStations = this.#buildAidStations(profile, segments, athlete, locale);

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
      },
      pacing,
      hydration,
      nutrition,
      aidStations,
      segments,
      generatedAt: new Date().toISOString(),
    };
  }

  async #buildAthleteBaseline(userId) {
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

    return {
      level,
      baselinePaceMinPerKm: round2(baselinePaceMinPerKm),
      weeklyDistanceKm: round2(weeklyDistanceKm),
      weeklyElevationGainM: Math.round(weeklyElevationGainM),
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

  #buildSegments(profile, athlete, locale) {
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
      const targetPaceMinPerKm = targetPaceForSegment({
        baselinePaceMinPerKm: athlete.baselinePaceMinPerKm,
        level: athlete.level,
        gradePct,
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

  #buildHydrationPlan(segments, athlete, locale) {
    const baseMlPerHour = athlete.level === 'advanced' ? 650 : athlete.level === 'intermediate' ? 600 : 550;
    const totalMl = Math.round(
      sum(segments, (segment) => (segment.estimatedDurationMin / 60) * baseMlPerHour * effortFactor(segment.effort))
    );
    const perStopMl = 180;
    const stops = [];
    let nextStopAtMin = 20;
    let elapsed = 0;
    for (const segment of segments) {
      const segmentEnd = elapsed + segment.estimatedDurationMin;
      while (nextStopAtMin <= segmentEnd) {
        const ratio = segment.estimatedDurationMin > 0
          ? Math.max(0, Math.min(1, (nextStopAtMin - elapsed) / segment.estimatedDurationMin))
          : 0;
        const atKm = segment.startKm + (segment.distanceKm * ratio);
        stops.push({
          atKm: round2(atKm),
          action: `${perStopMl} ml`,
        });
        nextStopAtMin += 20;
      }
      elapsed = segmentEnd;
    }

    return {
      totalMl,
      guideline: formatHydrationGuideline(locale, Math.round(baseMlPerHour)),
      stops,
    };
  }

  #buildNutritionPlan(segments, athlete, locale) {
    const carbsPerHour = athlete.level === 'advanced' ? 80 : athlete.level === 'intermediate' ? 65 : 50;
    const totalHours = sum(segments, (segment) => segment.estimatedDurationMin) / 60;
    const totalCarbsG = Math.round(totalHours * carbsPerHour);
    const feeds = [];
    let elapsed = 0;
    let nextFeedAtMin = 30;
    for (const segment of segments) {
      const segmentEnd = elapsed + segment.estimatedDurationMin;
      while (nextFeedAtMin <= segmentEnd) {
        const ratio = segment.estimatedDurationMin > 0
          ? Math.max(0, Math.min(1, (nextFeedAtMin - elapsed) / segment.estimatedDurationMin))
          : 0;
        const atKm = segment.startKm + (segment.distanceKm * ratio);
        feeds.push({
          atKm: round2(atKm),
          carbsG: athlete.level === 'advanced' ? 30 : 25,
          type: 'gel/drink mix',
        });
        nextFeedAtMin += 30;
      }
      elapsed = segmentEnd;
    }
    return {
      totalCarbsG,
      guideline: formatNutritionGuideline(locale, carbsPerHour),
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

    const ml = athlete.level === 'advanced' ? 220 : athlete.level === 'intermediate' ? 200 : 180;
    const carbs = athlete.level === 'advanced' ? 30 : 25;
    return deduped.map((item) => ({
      atKm: item.atKm,
      reason: item.reason,
      hydrationMl: ml,
      carbsG: carbs,
    }));
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
  return locale === 'fr'
    ? `${mlPerHour} ml/h ajuste selon l'effort`
    : `${mlPerHour} ml/h adjusted by effort`;
}

function formatNutritionGuideline(locale, carbsPerHour) {
  return locale === 'fr'
    ? `${carbsPerHour} g glucides/h`
    : `${carbsPerHour} g carbs/h`;
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

function targetPaceForSegment({ baselinePaceMinPerKm, level, gradePct }) {
  const paceFactor = paceFactorFromGrade(gradePct);
  const levelFactor = level === 'advanced' ? 0.96 : level === 'intermediate' ? 1 : 1.05;
  const terrain = resolveTerrain(gradePct);
  const terrainFactor = terrain === 'climb'
    ? (level === 'advanced' ? 1.14 : level === 'intermediate' ? 1.18 : 1.24)
    : terrain === 'downhill'
      ? (level === 'advanced' ? 0.9 : level === 'intermediate' ? 0.93 : 0.96)
      : 1;
  return baselinePaceMinPerKm * paceFactor * levelFactor * terrainFactor;
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

function round4(value) {
  return Math.round((Number(value) + Number.EPSILON) * 10000) / 10000;
}

module.exports = { RaceService };
