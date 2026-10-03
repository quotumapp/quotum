/** Sandbox checkout only. Fulfilment runs from verified server events, never browser callbacks. */
export function paddlePaymentPage(clientToken: string): string {
	if (!/^test_[a-zA-Z0-9]+$/.test(clientToken)) throw new Error("Sandbox client token required");
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Quotum Paddle sandbox</title><script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script></head><body><main><h1>Quotum Paddle sandbox checkout</h1><p>Test payments only. Open the checkout link returned by Quotum.</p><p id="status" role="status">Waiting for checkout</p></main><script>
Paddle.Environment.set("sandbox");
Paddle.Initialize({token:${JSON.stringify(clientToken)},checkout:{settings:{variant:"one-page",allowLogout:false,showAddDiscounts:false}},eventCallback:function(event){document.getElementById("status").textContent=event.name==="checkout.completed"?"Payment completed. Waiting for verified billing updates.":event.name;}});
</script></body></html>`;
}
