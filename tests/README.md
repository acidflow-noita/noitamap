## Structure

```
tests/
  drawing/              # Tests for drawing functionality
    *.test.ts          # Unit tests
    *.e2e.test.ts      # End-to-end tests
```

## Test Types

### Unit Tests (`*.test.ts`)
- Test individual functions and components in isolation
- Fast execution (< 100ms per test)
- No external dependencies
- Examples: `binary-encoder.test.ts`, `shape-validation.test.ts`

### E2E Tests (`*.e2e.test.ts`)
- Test complete user workflows from start to finish
- Test integration between multiple components
- Examples: `drawing-workflow.e2e.test.ts`

### Integration Tests (with mocks)
- Test API integrations with mocked responses
- Examples: `link-shortener.test.ts`, `cloud-storage.test.ts`

## Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm test -- --watch

# Run only E2E tests
npm test -- --grep "e2e"

# Run tests excluding E2E
npm test -- --grep -v "e2e"

# Run tests for specific module
npm test -- drawing

# Run with coverage
npm test -- --coverage
```

## Writing Tests

### File Naming
- Unit tests: `[module-name].test.ts`
- E2E tests: `[workflow-name].e2e.test.ts`
- Place tests in the same directory structure as the source file

### Import Paths
All imports from `src/` should use relative paths from the test file:
```typescript
import { myFunction } from '../../src/module/file';
```

### Test Structure
```typescript
describe('Module Name', () => {
  describe('Feature', () => {
    it('should do something specific', () => {
      // Arrange
      const input = ...;
      
      // Act
      const result = myFunction(input);
      
      // Assert
      expect(result).toBe(expected);
    });
  });
});
```
