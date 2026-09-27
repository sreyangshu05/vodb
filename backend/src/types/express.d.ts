declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        name?: string;
        email: string;
        role: 'member' | 'admin' | 'editor';
      };
    }
  }
}

export {};
