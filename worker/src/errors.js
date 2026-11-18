// Erros de domínio. UserError/AuthError têm mensagem segura para mostrar ao usuário.
export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
    this.status = 400;
  }
}

export class AuthError extends UserError {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
    this.status = 401;
  }
}

// Falha ao falar com o Google; a mensagem interna nunca vai ao cliente.
export class GoogleError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'GoogleError';
    this.status = status;
  }
}
