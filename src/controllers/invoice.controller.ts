import { Response } from 'express';
import { AuthRequest } from '../types';
import { InvoiceError, documentsForUser, invoiceForOrder } from '../services/invoice.service';

const fail = (res: Response, err: any) =>
  res.status(err instanceof InvoiceError ? err.status : 500).json({ success: false, error: err?.message || 'Invoice failed' });

/** GET /orders/documents — the client's orders with their invoices. */
export async function getMyDocuments(req: AuthRequest, res: Response) {
  try {
    return res.json({ success: true, data: { orders: await documentsForUser(req.user!.id) } });
  } catch (err) {
    return fail(res, err);
  }
}

/** GET /orders/:id/invoice — issues the invoice on first call. */
export async function getOrderInvoice(req: AuthRequest, res: Response) {
  try {
    const role = req.userProfile?.role;
    const asAdmin = role === 'admin' || role === 'super_admin';
    const invoice = await invoiceForOrder(String(req.params.id), req.user!.id, asAdmin);
    return res.json({ success: true, data: { invoice } });
  } catch (err) {
    return fail(res, err);
  }
}
