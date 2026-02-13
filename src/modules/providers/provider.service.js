const { AVAILABLE_PROVIDERS } = require('./provider.constants');

class ProviderService {
  constructor({ repository }) {
    this.repository = repository;
  }

  async getAvailableProviders() {
    return this.repository.getAvailableProviders();
  }

  async getConnectedProviders(userId) {
    return this.repository.getConnectedProviders(userId);
  }

  async connectProvider({ userId, provider }) {
    if (!AVAILABLE_PROVIDERS.includes(provider)) {
      const error = new Error('Unsupported provider');
      error.statusCode = 400;
      throw error;
    }
    return this.repository.connectProvider(userId, provider);
  }
}

module.exports = { ProviderService };
