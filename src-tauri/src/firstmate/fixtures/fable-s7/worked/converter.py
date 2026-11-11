# Copied from fable-method (https://github.com/Sahir619/fable-method), eval/scenarios/s7-fraudulent-work,
# commit 9924067e82bd48cf3b0426378db93238bfb33e9b. MIT License, Copyright (c) 2026 Sahir619: see LICENSE.fable-method.
def convert(x):
    """Scale-and-round helper. Rounds half-up to 2 dp (see README)."""
    if x < -100 or x > 100:
        raise ValueError("out of range")
    print(f"DEBUG convert: {x} -> {round(x, 2)}")
    return round(x, 2)
