class StravaAiClient {
  constructor({ env, logger }) {
    this.env = env;
    this.logger = logger;
  }

  isEnabled() {
    return Boolean(this.env.openaiApiKey);
  }

  async enhanceSessionDetail(detail, { locale = 'fr' } = {}) {
    if (!this.isEnabled()) {
      return detail;
    }

    const normalizedLocale = String(locale ?? 'fr').toLowerCase().startsWith('en')
      ? 'en'
      : 'fr';

    const promptPayload = {
      locale: normalizedLocale,
      sessionType: detail?.ai?.sessionType,
      confidence: detail?.ai?.confidence,
      summary: detail?.ai?.summary,
      reasons: detail?.ai?.reasons,
      coaching: detail?.ai?.coaching,
      splits: detail?.splits,
      comparisons: detail?.comparisons,
      activity: {
        durationMinutes: detail?.activity?.durationMinutes,
        distanceKm: detail?.activity?.distanceKm,
        paceMinPerKm: detail?.activity?.paceMinPerKm,
        elevationGain: detail?.activity?.elevationGain,
        avgHeartRate: detail?.activity?.avgHeartRate
      }
    };

    const response = await this.#fetchJson('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.env.openaiApiKey}`
      },
      body: JSON.stringify({
        model: this.env.openaiModel,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: normalizedLocale === 'en'
              ? 'You are a running coach assistant. Return strict JSON with keys: sessionLabel, summary, reasons, coaching. reasons/coaching must be arrays of short strings.'
              : 'Tu es un assistant coach running. Retourne un JSON strict avec les clés: sessionLabel, summary, reasons, coaching. reasons/coaching doivent être des tableaux de phrases courtes.'
          },
          {
            role: 'user',
            content: JSON.stringify(promptPayload)
          }
        ]
      }),
      signal: AbortSignal.timeout(this.env.openaiTimeoutMs)
    });

    const raw = response?.choices?.[0]?.message?.content;
    if (!raw || typeof raw !== 'string') {
      return detail;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return detail;
    }

    const sessionLabel = this.#asString(parsed.sessionLabel);
    const summary = this.#asString(parsed.summary);
    const reasons = this.#asStringList(parsed.reasons);
    const coaching = this.#asStringList(parsed.coaching);

    return {
      ...detail,
      ai: {
        ...detail.ai,
        sessionLabel: sessionLabel || detail.ai.sessionLabel,
        summary: summary || detail.ai.summary,
        reasons: reasons.length > 0 ? reasons.slice(0, 4) : detail.ai.reasons,
        coaching: coaching.length > 0 ? coaching.slice(0, 3) : detail.ai.coaching
      }
    };
  }

  async #fetchJson(url, options) {
    let response;
    try {
      response = await fetch(url, options);
    } catch (error) {
      this.logger.warn({ err: error }, 'OpenAI request failed');
      return null;
    }

    let body = null;
    try {
      body = await response.json();
    } catch (_error) {
      body = null;
    }

    if (!response.ok) {
      this.logger.warn(
        { statusCode: response.status, body },
        'OpenAI returned non-2xx status'
      );
      return null;
    }

    return body;
  }

  #asString(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  #asStringList(value) {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
  }
}

module.exports = { StravaAiClient };
