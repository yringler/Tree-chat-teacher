import { createMemoryRepositories } from '../src/memory/memory-repositories.js';
import { describeRepositories } from './repository-contract.js';

describeRepositories('memory', () => createMemoryRepositories());
