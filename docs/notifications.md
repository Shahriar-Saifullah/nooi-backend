# In-app notifications

All notifications go through `src/services/notifications.service.ts` (backend)
or `app/api/_lib/notify.ts` (frontend API routes). Both write to the
`notifications` table; everyone sees theirs in the bell (customers: shop header
and dashboard; vendors: vendor dashboard; admins: admin sidebar).

A failed notification never fails the action that caused it.

| Event | Customer | Vendor | Admins | Where |
|---|---|---|---|---|
| Order paid | Order confirmed | New order (their items + total) | — | orders.controller `notifyNewOrder` |
| Payment refunded instead (price/amount/currency mismatch) | We couldn't complete your order | — | — | orders.controller `fail()` |
| Item sold out during payment | Sold out, refunded | — | — | orders.controller |
| Order sells a variant's last unit | — | Out of stock | — | orders.controller `notifyNewOrder` |
| Factory stage (materials / production / QC / ready) | Progress update | — | — | app/api/vendor/orders/[shipmentId]/stage |
| Vendor dispatches (tracking) | Shipped + tracking | — | — | vendor.controller `dispatchShipment` |
| Out for delivery / delivered (vendor) | Update | — | — | vendor.controller `advanceShipmentStatus` |
| Delivery confirmed by Nooi | Delivered | Delivery confirmed | — | admin.controller `markShipmentDelivered` |
| Customer asks to cancel | — | Hold this order | New request | cancellations.controller |
| Vendor asks to cancel their part | — | — | New request | cancellations.controller |
| Cancellation approved | Cancelled + refund | Don't ship (or: approved, if they asked) | — | ops.controller |
| Cancellation declined | (if they asked) Declined | Order goes ahead / Declined | — | ops.controller |
| Nooi cancels an order | Cancelled + refund | Don't ship | — | admin.controller `cancelOrderAsAdmin` |
| Nooi changes order status | Status update | Status update | — | admin.controller `overrideOrderStatus` |
| Nooi approves order for payment | — | Approved for payment | — | admin.controller `approveOrder` |
| Return requested | Request received | Return requested | New return | orders.controller `submitReturnRequest` |
| Return refunded | Refund on its way | Return refunded (deducted) | — | admin.controller `refundReturn` |
| Return declined | Declined + reason | — | — | admin.controller `declineReturn` |
| Vendor application submitted | — | Application received | New application | app/api/vendor/submit |
| Vendor approved / rejected / suspended | — | Decision | — | admin.controller |
| New listing / listing resubmitted | — | — | Listing to review | app/api/vendor/listings |
| Listing approved / changes / taken down | — | Decision | — | ops.controller `decideListing` |
| 3D model ready / failed | — | — | Ready to review / failed | services/model3d |
| 3D model approved or uploaded | — | 3D model added | — | models.controller |
| Vendor adds a bank account | — | — | Account to verify | vendor.controller |
| Bank account verified | — | Verified | — | admin.controller |
| Payout sent / paid / failed / returned | — | Payout update | — | payouts.service `applyStatus` |
| Product review posted | — | New review | — | marketplace.controller |
| Support ticket opened | — | — | New ticket | support.controller |
| Requester replies | — | — | Reply (assigned admin, or all) | support.controller |
| Nooi replies | Reply | Reply | — | ops.controller |

Links: customers → `/orders/:id`, `/support?ticket=`; vendors →
`/sell/orders?order=<number>`, `/sell/products`, `/sell/returns`,
`/sell/payments`, `/sell/support?ticket=`; admins → `/admin/<section>?id=`.

## Switching notifications off

People choose on Profile → Notifications (`profiles.notification_prefs`, e.g.
`{ "shipment": false }`; a missing key means on). The switchable types are
`SWITCHABLE_TYPES` in notifications.service.ts (keep `app/api/_lib/notify.ts`
in the frontend in step). A notification sent with `essential: true` ignores
the switch — use it for refunds, cancellations, payment problems, account and
listing decisions, failed payouts, and "don't ship this order" messages to
vendors. Admin alerts can't be switched off.
