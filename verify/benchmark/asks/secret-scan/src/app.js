// The billing page's server side. Settings come from the environment, which is why nothing here holds a key.
export function priceFor(plan) {
  const prices = { starter: 19, team: 49, scale: 99 };
  const price = prices[plan];
  if (!price) throw new Error(`unknown plan: ${plan}`);
  return price;
}

export function checkoutUrl(base, plan) {
  return `${base}/checkout?plan=${encodeURIComponent(plan)}`;
}
