import { z } from 'zod';

// Zod probes for eval-based JIT with Function(''); the CSP forbids eval, so opt
// out. Imported first in main.tsx, before any schema is created.
z.config({ jitless: true });
