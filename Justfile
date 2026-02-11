# Default recipe runs all tests
default: test

# Run all tests
test: test-basic test-html5lib

# Run tests that don't require external dependencies
test-basic:
    node --experimental-strip-types --test tests/smoke.test.ts tests/selector.test.ts tests/stream.test.ts tests/markdown.test.ts

# Run tests that require html5lib-tests
test-html5lib: fetch-html5lib-tests
    node --experimental-strip-types --test tests/html5lib-encoding.test.ts tests/html5lib-tokenizer.test.ts tests/html5lib-tree-construction.test.ts tests/html5lib-serializer.test.ts

# Fetch html5lib-tests if not present
fetch-html5lib-tests:
    #!/usr/bin/env bash
    if [ ! -d "html5lib-tests" ]; then
        git clone https://github.com/html5lib/html5lib-tests html5lib-tests
    fi

# Run tests with coverage report
coverage: fetch-html5lib-tests
    npx c8 --include 'src/**' just _run-all-tests

# Run tests with coverage and write to file
coverage-write: fetch-html5lib-tests
    npx c8 --include 'src/**' --reporter=lcov --reporter=text just _run-all-tests

# Internal: run all test scripts (used by coverage)
_run-all-tests:
    node --experimental-strip-types --test tests/smoke.test.ts tests/selector.test.ts tests/stream.test.ts tests/markdown.test.ts tests/html5lib-encoding.test.ts tests/html5lib-tokenizer.test.ts tests/html5lib-tree-construction.test.ts tests/html5lib-serializer.test.ts
