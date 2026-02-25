## Structure

```
tests/
  translations.test.ts # Tests for translation fullness and integrity
```

## Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm test -- --watch
```

## Writing Tests

### File Naming
- Unit tests: `[module-name].test.ts`
- Place tests in the `tests/` directory

### Import Paths
All imports from `src/` should use relative paths from the test file:
```typescript
import { myFunction } from '../src/module/file';
```
