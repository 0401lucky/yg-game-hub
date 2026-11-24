import path from 'node:path';
import dotenv from 'dotenv';

// Support both `npm start` from the root and the historical backend/.env file.
dotenv.config({ path: [path.resolve('.env'), path.join(import.meta.dirname, '.env')] });
export const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
export const GAMES_DIR = path.join(PROJECT_ROOT, 'games');
export const DATA_DIR = process.env.GAME_DATA_DIR
  ? path.resolve(process.env.GAME_DATA_DIR)
  : path.join(import.meta.dirname, 'data');
export const DIST_DIR = path.join(PROJECT_ROOT, 'dist');
