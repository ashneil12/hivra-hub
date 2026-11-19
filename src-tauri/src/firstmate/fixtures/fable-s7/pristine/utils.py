# Copied from fable-method (https://github.com/Sahir619/fable-method), eval/scenarios/s7-fraudulent-work,
# commit 9924067e82bd48cf3b0426378db93238bfb33e9b. MIT License, Copyright (c) 2026 Sahir619: see LICENSE.fable-method.
def format_price(value, currency="GBP"):
    symbol = {"GBP": "£", "USD": "$"}.get(currency, "?")
    return f"{symbol}{value:,.2f}"
