import './loadEnv';
import "reflect-metadata"; // Required for TypeORM
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import axios from 'axios';
import cron from 'node-cron';
import { In, IsNull } from 'typeorm';
import { AppDataSource, Event, Ticket, Order, User, TicketType, SeatMap, SupportReport, CouponCode } from '@tartan/db';
import { sendOrderConfirmationEmail, sendPaymentReceiptEmail, sendCancellationEmail } from '@tartan/mail';
import { isReservationExpired } from './reservationExpiry';

// Generate human-readable record locator (e.g. TARTAN-A1B2C3)
function generateRecordLocator(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `TARTAN-${code}`;
}

const app = express();
const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL || 'http://payment-service:3003';

app.use(express.json({ limit: '10mb' }));
app.use(cors());

if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET must be set');
}
const JWT_SECRET = process.env.JWT_SECRET;

// Helper to extract user from Authorization header
const getUserIdFromAuth = (req: express.Request): number | null => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return null;
    const token = authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : authHeader;
    if (!token) return null;
    try {
        const decoded = jwt.verify(token, JWT_SECRET) as { id: number };
        return decoded.id;
    } catch {
        return null;
    }
};

const trimOptional = (value: unknown, maxLength: number): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, maxLength);
};

type CouponLineItem = {
    ticketTypeId: number | null;
    quantity: number;
    lineTotalCents: number;
};

type CouponCartSummary = {
    subtotalCents: number;
    lineItems: CouponLineItem[];
};

const normalizeCouponCode = (value: unknown): string => {
    if (typeof value !== 'string') return '';
    return value.trim().toUpperCase().slice(0, 64);
};

const buildCouponCartSummary = async (eventId: number, requestedTickets?: Record<string, number>): Promise<CouponCartSummary> => {
    if (!requestedTickets || Object.keys(requestedTickets).length === 0) {
        return { subtotalCents: 0, lineItems: [] };
    }

    const requestedIds = Object.entries(requestedTickets)
        .filter(([, quantity]) => Number(quantity) > 0)
        .map(([ticketTypeId]) => Number(ticketTypeId))
        .filter((ticketTypeId) => Number.isInteger(ticketTypeId) && ticketTypeId > 0);

    if (requestedIds.length === 0) {
        return { subtotalCents: 0, lineItems: [] };
    }

    const ticketTypeRepo = AppDataSource.getRepository(TicketType);
    const ticketTypes = await ticketTypeRepo.find({
        where: {
            eventId,
            id: In(requestedIds),
        },
    });

    const ticketTypeMap = new Map<number, TicketType>(
        ticketTypes.map((ticketType) => [ticketType.id, ticketType] as const)
    );
    let subtotalCents = 0;
    const lineItems: CouponLineItem[] = [];

    for (const [ticketTypeId, rawQuantity] of Object.entries(requestedTickets)) {
        const parsedTicketTypeId = Number(ticketTypeId);
        const quantity = Math.max(0, Math.floor(Number(rawQuantity) || 0));
        const ticketType = ticketTypeMap.get(parsedTicketTypeId);

        if (!ticketType || quantity === 0) {
            continue;
        }

        const lineTotalCents = ticketType.priceCents * quantity;
        subtotalCents += lineTotalCents;
        lineItems.push({
            ticketTypeId: ticketType.id,
            quantity,
            lineTotalCents,
        });
    }

    return { subtotalCents, lineItems };
};

const findCouponForEvent = async (eventId: number, rawCouponCode: unknown): Promise<CouponCode | null> => {
    const couponCode = normalizeCouponCode(rawCouponCode);
    if (!couponCode) {
        return null;
    }

    const couponRepo = AppDataSource.getRepository(CouponCode);
    const coupons = await couponRepo.find({
        where: [
            { code: couponCode, active: true, eventId },
            { code: couponCode, active: true, eventId: IsNull() },
        ],
        order: { eventId: 'DESC' },
    });

    return coupons[0] || null;
};

const evaluateCoupon = (coupon: CouponCode, cartSummary: CouponCartSummary) => {
    const now = Date.now();

    if (coupon.startsAt && new Date(coupon.startsAt).getTime() > now) {
        return { valid: false, reason: 'Coupon is not active yet', discountAmountCents: 0 };
    }

    if (coupon.endsAt && new Date(coupon.endsAt).getTime() < now) {
        return { valid: false, reason: 'Coupon has expired', discountAmountCents: 0 };
    }

    if (coupon.maxRedemptions > 0 && coupon.currentRedemptions >= coupon.maxRedemptions) {
        return { valid: false, reason: 'Coupon is no longer available', discountAmountCents: 0 };
    }

    const eligibleSubtotalCents = coupon.ticketTypeId
        ? cartSummary.lineItems
            .filter((lineItem) => lineItem.ticketTypeId === coupon.ticketTypeId)
            .reduce((sum, lineItem) => sum + lineItem.lineTotalCents, 0)
        : cartSummary.subtotalCents;

    if (eligibleSubtotalCents <= 0) {
        return { valid: false, reason: 'Coupon does not apply to this order', discountAmountCents: 0 };
    }

    const rawDiscountCents = coupon.discountType === 'AMOUNT'
        ? coupon.amountOffCents
        : Math.round(eligibleSubtotalCents * ((coupon.percentOff || 0) / 100));

    return {
        valid: true,
        reason: null,
        discountAmountCents: Math.max(0, Math.min(cartSummary.subtotalCents, rawDiscountCents)),
    };
};

const mapEventForPublicCatalog = <T extends Event & { ticketTypes?: TicketType[]; tickets?: Ticket[] }>(event: T) => {
    const generalAdmissionSold = (event.tickets || []).filter(
        (ticket) => ticket.status === 'booked' && !ticket.seatNumber
    ).length;

    return {
        ...event,
        ticketTypes: (event.ticketTypes || []).map((ticketType) => {
            if (ticketType.availabilityModel !== 'GA_POOL') {
                return ticketType;
            }

            return {
                ...ticketType,
                available: Math.max(0, ticketType.available - generalAdmissionSold),
            };
        }),
    };
};

// Middleware to require admin role
const requireAdmin = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
    const token = authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : authHeader;
    try {
        const decoded = jwt.verify(token, JWT_SECRET) as { id: number; role: string };
        if (decoded.role !== 'admin') return res.status(403).json({ error: 'Forbidden: admin access required' });
        next();
    } catch {
        return res.status(401).json({ error: 'Unauthorized' });
    }
};

// Initialize Database Connection
AppDataSource.initialize()
    .then(() => {
        console.log("Ticket Service: Database connected via TypeORM");

        // Auto-publish scheduled events every minute
        cron.schedule('* * * * *', async () => {
            try {
                const result = await AppDataSource.getRepository(Event)
                    .createQueryBuilder()
                    .update(Event)
                    .set({ status: 'PUBLISHED' })
                    .where('publish_at <= :now AND status != :status', { now: new Date(), status: 'PUBLISHED' })
                    .execute();
                if (result.affected && result.affected > 0) {
                    console.log(`Auto-published ${result.affected} event(s)`);
                }
            } catch (err) {
                console.error('Auto-publish cron error:', err);
            }
        });
    })
    .catch((err) => {
        console.error("Ticket Service: Error connecting to database", err);
    });

app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'ticket-service' });
});

app.get('/events', async (req, res) => {
    try {
    const eventRepo = AppDataSource.getRepository(Event);
    const searchRaw = req.query.search != null ? String(req.query.search).trim().slice(0, 200) : '';
    const search = searchRaw || '';

    const qb = eventRepo
        .createQueryBuilder('event')
        .leftJoinAndSelect('event.ticketTypes', 'ticketTypes')
        .leftJoinAndSelect('event.tickets', 'tickets')
        .where("event.status = 'PUBLISHED'");
    if (search) {
        qb.andWhere(
            '(LOWER(event.name) LIKE :s OR LOWER(event.location) LIKE :s)',
            { s: `%${search.toLowerCase()}%` }
        );
    }
    qb.orderBy('event.date', 'ASC');
    const events = await qb.getMany();

    res.json(events.map(mapEventForPublicCatalog));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

app.get('/events/:id', async (req, res) => {
    try {
    const eventRepo = AppDataSource.getRepository(Event);

    const event = await eventRepo.findOne({
        where: { id: parseInt(req.params.id) },
        relations: ['ticketTypes', 'seatMap', 'tickets']
    });

    if (!event) return res.status(404).json({ error: 'Event not found' });

    res.json(mapEventForPublicCatalog(event));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Get seat availability - returns which seats are taken (reserved or booked)
app.get('/events/:id/seats', async (req, res) => {
    try {
        const eventId = parseInt(req.params.id);
        if (!Number.isInteger(eventId)) {
            return res.status(400).json({ error: 'Invalid event id' });
        }
        const ticketRepo = AppDataSource.getRepository(Ticket);

        const tickets = await ticketRepo.find({
            where: {
                eventId,
                status: In(['reserved', 'booked'])
            }
        });

        const availability: Record<string, string> = {};
        for (const t of tickets) {
            if (!t.seatNumber) {
                continue;
            }
            if (t.status === 'reserved' && isReservationExpired(t)) {
                continue;
            }
            availability[t.seatNumber] =
                t.status === 'booked' ? 'sold' : 'unavailable';
        }

        res.json({
            eventId,
            availability
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch seat availability' });
    }
});

// Reserve a single seat: POST /events/:id/seats/:seat/reserve
app.post('/events/:id/seats/:seat/reserve', async (req, res) => {
    try {
        const userId = getUserIdFromAuth(req);
        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const eventId = parseInt(req.params.id);
        if (!Number.isInteger(eventId)) {
            return res.status(400).json({ error: 'Invalid event id' });
        }
        const seatId = decodeURIComponent(req.params.seat);

        const ticketRepo = AppDataSource.getRepository(Ticket);
        const eventRepo = AppDataSource.getRepository(Event);

        const event = await eventRepo.findOne({
            where: { id: eventId },
            relations: ['seatMap']
        });
        if (!event) {
            return res.status(404).json({ error: 'Event not found' });
        }

        const existing = await ticketRepo.findOne({
            where: {
                eventId,
                seatNumber: seatId,
                status: In(['reserved', 'booked'])
            }
        });
        if (existing) {
            if (existing.status === 'reserved' && isReservationExpired(existing)) {
                await ticketRepo.delete(existing.id);
            } else {
                return res.status(409).json({
                    error: 'Seat not available',
                    seat: seatId
                });
            }
        }

        const ticket = ticketRepo.create({
            eventId,
            userId,
            seatNumber: seatId,
            status: 'reserved'
        });
        await ticketRepo.save(ticket);

        res.json({
            success: true,
            reserved: seatId
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to reserve seat' });
    }
});

// Release a single seat: POST /events/:id/seats/:seat/release
app.post('/events/:id/seats/:seat/release', async (req, res) => {
    try {
        const userId = getUserIdFromAuth(req);
        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const eventId = parseInt(req.params.id);
        if (!Number.isInteger(eventId)) {
            return res.status(400).json({ error: 'Invalid event id' });
        }
        const seatId = decodeURIComponent(req.params.seat);

        const ticketRepo = AppDataSource.getRepository(Ticket);

        const result = await ticketRepo.delete({
            eventId,
            userId,
            seatNumber: seatId,
            status: 'reserved'
        });

        if (result.affected === 0) {
            return res.status(404).json({ error: 'Reservation not found', seat: seatId });
        }

        res.json({
            success: true,
            released: seatId
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to release seat' });
    }
});

app.post('/events/:id/coupons/preview', async (req, res) => {
    try {
        const eventId = parseInt(req.params.id);
        if (!Number.isInteger(eventId)) {
            return res.status(400).json({ error: 'Invalid event id' });
        }

        const { couponCode, tickets } = req.body as {
            couponCode?: string;
            tickets?: Record<string, number>;
        };

        const coupon = await findCouponForEvent(eventId, couponCode);
        if (!coupon) {
            return res.status(404).json({ error: 'Coupon not found' });
        }

        const cartSummary = await buildCouponCartSummary(eventId, tickets);
        const evaluation = evaluateCoupon(coupon, cartSummary);

        if (!evaluation.valid) {
            return res.status(400).json({ error: evaluation.reason || 'Coupon does not apply' });
        }

        res.json({
            code: coupon.code,
            discountAmountCents: evaluation.discountAmountCents,
            subtotalCents: cartSummary.subtotalCents,
            totalAmountCents: Math.max(0, cartSummary.subtotalCents - evaluation.discountAmountCents),
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to preview coupon' });
    }
});

// Checkout: convert reserved tickets to booked and process payment via TartanPay
if (!process.env.TARTANPAY_API_KEY) {
    throw new Error('TARTANPAY_API_KEY must be set');
}
const TARTANPAY_API_KEY = process.env.TARTANPAY_API_KEY;
const tartanPayHeaders = () => ({
    headers: { Authorization: `Bearer ${TARTANPAY_API_KEY}`, 'Content-Type': 'application/json' },
});

// TartanPay's POST /v1/customers is "find by email, then insert" without
// handling the unique-email violation. Two concurrent first checkouts for the
// same user make TartanPay throw an unhandled error and exit, which takes the
// payment service down for every later checkout. Serialize customer creation
// per email inside this (single-instance) service so TartanPay never sees
// concurrent creates for the same customer.
const customerCreationQueue = new Map<string, Promise<void>>();

async function withCustomerCreationLock<T>(email: string, fn: () => Promise<T>): Promise<T> {
    const key = email.trim().toLowerCase();
    const previous = customerCreationQueue.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
        release = resolve;
    });
    const tail = previous.then(() => current);
    customerCreationQueue.set(key, tail);

    await previous;
    try {
        return await fn();
    } finally {
        release();
        if (customerCreationQueue.get(key) === tail) {
            customerCreationQueue.delete(key);
        }
    }
}

app.post('/events/:id/checkout', async (req, res) => {
    try {
        const userId = getUserIdFromAuth(req);
        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const eventId = parseInt(req.params.id);
        if (!Number.isInteger(eventId)) {
            return res.status(400).json({ error: 'Invalid event id' });
        }
        const {
            seatIds,
            tickets: gaTickets,
            couponCode,
            cardNumber,
            cardExpMonth,
            cardExpYear,
            cardCvc,
            saveCard,
        } = req.body as {
            seatIds: string[];
            tickets?: Record<string, number>;
            totalPriceCents?: number;
            couponCode?: string;
            discountAmountCents?: number;
            cardNumber?: string;
            cardExpMonth?: number;
            cardExpYear?: number;
            cardCvc?: string;
            saveCard?: boolean;
        };

        const isGA = !Array.isArray(seatIds) || seatIds.length === 0;

        if (isGA && (!gaTickets || Object.keys(gaTickets).length === 0)) {
            return res.status(400).json({ error: 'seatIds array or tickets map required' });
        }

        if (!isGA && seatIds.length === 0) {
            return res.status(400).json({ error: 'seatIds array required' });
        }

        const ticketRepo = AppDataSource.getRepository(Ticket);
        const ticketTypeRepo = AppDataSource.getRepository(TicketType);

        let tickets: Ticket[];
        let authoritativeCartSummary: CouponCartSummary;

        if (isGA) {
            // Calculate the authoritative GA subtotal from TicketType.priceCents.
            authoritativeCartSummary = await buildCouponCartSummary(
                eventId,
                gaTickets
            );

                const ticketTypeRepo = AppDataSource.getRepository(TicketType);
                for (const [ticketTypeId, qty] of Object.entries(gaTickets!)) {
                    const parsedTicketTypeId = Number(ticketTypeId);
                    if (!Number.isInteger(parsedTicketTypeId)) {
                        return res.status(400).json({ error: 'Invalid ticket type' });
                    }
                    const ticketType = await ticketTypeRepo.findOne({
                        where: {
                            id: parsedTicketTypeId,
                            eventId,
                        },
                    });
                    if (!ticketType) {
                        return res.status(400).json({ error: 'Invalid ticket type' });
                    }
                    if (!Number.isInteger(qty) || qty <= 0) {
                        return res.status(400).json({
                            error: 'Ticket quantity must be a positive integer',
                        });
                    }
                    if (ticketType.maxPerOrder > 0 && qty > ticketType.maxPerOrder) {
                        return res.status(400).json({
                            error: `Maximum ${ticketType.maxPerOrder} tickets allowed per order`,
                        });
                    }
                }
                const newTickets: Ticket[] = [];

                for (const [, qty] of Object.entries(gaTickets!)) {
                    for (let i = 0; i < qty; i++) {
                        newTickets.push(ticketRepo.create({
                            eventId,
                            userId,
                            seatNumber: null as any,
                            status: 'reserved'
                        }));
                    }
                }

            tickets = await ticketRepo.save(newTickets);
        } else {
            // Verify that the requested seats are actually reserved by this user.
            tickets = await ticketRepo.find({
                where: {
                    eventId,
                    userId,
                    seatNumber: In(seatIds),
                    status: 'reserved'
                }
            });

            const expiredTickets = tickets.filter(isReservationExpired);

            if (expiredTickets.length > 0) {
                for (const ticket of expiredTickets) {
                    await ticketRepo.delete(ticket.id);
                }

                return res.status(400).json({
                    error: 'Some seat reservations have expired',
                    expired: expiredTickets.map((ticket) => ticket.seatNumber)
                });
            }

            if (tickets.length !== seatIds.length) {
                const foundSeats = new Set(tickets.map(t => t.seatNumber));
                const missing = seatIds.filter(id => !foundSeats.has(id));

                return res.status(400).json({
                    error: 'Some seats are no longer reserved',
                    missing
                });
            }

            // Resolve the authoritative Reserved Seating price from the event's
            // TicketType instead of trusting a total supplied by the client.
            const reservedTicketTypes = await ticketTypeRepo.find({
                where: {
                    eventId,
                    availabilityModel: 'RESERVED_SEATS'
                }
            });

            if (reservedTicketTypes.length === 0) {
                return res.status(400).json({
                    error: 'Reserved seating ticket type not found'
                });
            }

            if (reservedTicketTypes.length > 1) {
                return res.status(400).json({
                    error: 'Unable to determine reserved seating ticket type'
                });
            }

            const reservedTicketType = reservedTicketTypes[0];
            const subtotalCents =
                reservedTicketType.priceCents * seatIds.length;

            authoritativeCartSummary = {
                subtotalCents,
                lineItems: [
                    {
                        ticketTypeId: reservedTicketType.id,
                        quantity: seatIds.length,
                        lineTotalCents: subtotalCents
                    }
                ]
            };
        }

        // The server-calculated subtotal is authoritative.
        // Client-supplied totalPriceCents is intentionally ignored.
        const authoritativeSubtotalCents =
            authoritativeCartSummary.subtotalCents;

        const normalizedCouponCode = normalizeCouponCode(couponCode);
        let appliedCoupon: CouponCode | null = null;
        let appliedDiscountCents = 0;

        if (normalizedCouponCode) {
            appliedCoupon = await findCouponForEvent(
                eventId,
                normalizedCouponCode
            );

            if (!appliedCoupon) {
                return res.status(400).json({ error: 'Coupon not found' });
            }

            const evaluation = evaluateCoupon(
                appliedCoupon,
                authoritativeCartSummary
            );

            if (!evaluation.valid) {
                return res.status(400).json({
                    error: evaluation.reason || 'Coupon does not apply'
                });
            }

            // Only the server-calculated coupon discount is trusted.
            // Client-supplied discountAmountCents is intentionally ignored.
            appliedDiscountCents = Math.min(
                authoritativeSubtotalCents,
                evaluation.discountAmountCents
            );
        }

        const totalAmount = Math.max(
            0,
            authoritativeSubtotalCents - appliedDiscountCents
        );

        // --- TartanPay two-phase payment flow ---
        const userRepo = AppDataSource.getRepository(User);
        const user = await userRepo.findOne({ where: { id: userId } });

        if (!user) {
            return res.status(401).json({ error: 'User not found' });
        }

        // 1. Ensure a TartanPay customer exists (idempotent by email)
        const custRes = await withCustomerCreationLock(user.email, () =>
            axios.post(
                `${PAYMENT_SERVICE_URL}/v1/customers`,
                {
                    email: user.email,
                    name: user.name
                },
                tartanPayHeaders()
            )
        );

        const customerId = custRes.data.id;

        // 2. Create PaymentIntent using the authoritative server-side amount.
        const intentRes = await axios.post(
            `${PAYMENT_SERVICE_URL}/v1/payment_intents`,
            {
                amount: totalAmount,
                currency: 'usd',
                customer: customerId,
                metadata: {
                    event_id: eventId,
                    user_id: userId
                }
            },
            tartanPayHeaders()
        );

        // 3. Confirm with card details
        const confirmBody: any = {
            payment_method: {
                card: {
                    number: cardNumber || '4242424242424242',
                    exp_month: cardExpMonth || 12,
                    exp_year: cardExpYear || 2030,
                    cvc: cardCvc || '123'
                }
            }
        };

        if (saveCard) {
            confirmBody.save_payment_method = true;
        }

        const confirmRes = await axios.post(
            `${PAYMENT_SERVICE_URL}/v1/payment_intents/${intentRes.data.id}/confirm`,
            confirmBody,
            tartanPayHeaders()
        );

        if (confirmRes.data.status !== 'succeeded') {
            return res.status(402).json({
                error: 'Payment failed',
                failure_code: confirmRes.data.failure_code,
                failure_message: confirmRes.data.failure_message
            });
        }

        const transactionId = intentRes.data.id;
        const cardLast4 = cardNumber
            ? cardNumber.slice(-4)
            : undefined;

        const cardBrand = cardNumber?.startsWith('4')
            ? 'visa'
            : cardNumber?.startsWith('5')
                ? 'mastercard'
                : cardNumber?.startsWith('3')
                    ? 'amex'
                    : 'card';

        // Create Order record in database
        const orderRepo = AppDataSource.getRepository(Order);
        const eventRepo = AppDataSource.getRepository(Event);

        const event = await eventRepo.findOne({
            where: { id: eventId }
        });

        if (!event) {
            return res.status(404).json({
                error: 'Event not found'
            });
        }

        let recordLocator = generateRecordLocator();

        while (await orderRepo.findOneBy({ recordLocator })) {
            recordLocator = generateRecordLocator();
        }

        const order = orderRepo.create({
            recordLocator,
            userId,
            eventId,
            paymentTransactionId: transactionId,
            totalAmountCents: totalAmount,
            couponCode: appliedCoupon?.code || null,
            discountAmountCents: appliedDiscountCents,
            status: 'confirmed',
            fulfillmentStatus: 'pending'
        });

        await orderRepo.save(order);

        await ticketRepo.update(
            {
                id: In(tickets.map(t => t.id))
            },
            {
                status: 'booked',
                orderId: order.id
            }
        );

        if (appliedCoupon) {
            await AppDataSource
                .getRepository(CouponCode)
                .increment(
                    { id: appliedCoupon.id },
                    'currentRedemptions',
                    1
                );
        }

        if (user) {
            const seatNumbers = tickets
                .map(t => t.seatNumber)
                .filter(Boolean) as string[];

            const orderConfirmationSent =
                await sendOrderConfirmationEmail(
                    user.email,
                    {
                        name: user.name,
                        recordLocator: order.recordLocator,
                        eventName: event.name,
                        eventDate: event.date?.toISOString() ?? 'TBD',
                        eventLocation: event.location ?? 'TBD',
                        ticketCount: tickets.length,
                        seatNumbers,
                        totalAmountCents: totalAmount
                    }
                );

            let receiptSent = totalAmount === 0;

            if (transactionId && totalAmount > 0) {
                receiptSent = await sendPaymentReceiptEmail(
                    user.email,
                    {
                        name: user.name,
                        recordLocator: order.recordLocator,
                        transactionId,
                        amountCents: totalAmount,
                        cardBrand: cardBrand ?? undefined,
                        cardLast4: cardLast4 ?? undefined,
                        eventName: event.name
                    }
                );
            }

            order.fulfillmentStatus =
                orderConfirmationSent && receiptSent
                    ? 'sent'
                    : orderConfirmationSent || receiptSent
                        ? 'partial'
                        : 'failed';

            try {
                await orderRepo.save(order);
            } catch (followupErr) {
                console.error(
                    'Failed to persist fulfillment status',
                    followupErr
                );
            }
        }

        res.json({
            success: true,
            orderId: order.id,
            recordLocator: order.recordLocator,
            transactionId,
            status: 'succeeded',
            fulfillmentStatus: order.fulfillmentStatus,
            couponCode: order.couponCode,
            discountAmountCents: order.discountAmountCents,
            totalAmountCents: order.totalAmountCents,
            ticketIds: tickets.map(t => t.id)
        });
    } catch (err: any) {
        console.error(err);

        if (
            err.response?.status === 402 ||
            err.response?.status === 502
        ) {
            return res.status(err.response.status).json(
                err.response?.data || {
                    error: 'Payment failed'
                }
            );
        }

        res.status(500).json({
            error: 'Failed to complete checkout'
        });
    }
});

// Get user's orders (requires auth)
app.get('/orders', async (req, res) => {
    try {
        const userId = getUserIdFromAuth(req);
        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const orderRepo = AppDataSource.getRepository(Order);
        const orders = await orderRepo.find({
            where: { userId },
            relations: ['event', 'tickets'],
            order: { createdAt: 'DESC' },
        });

        const result = orders.map((order) => {
            const event = order.event as Event;
            const tickets = order.tickets || [];
            const seatNumbers = tickets
                .filter((t) => t.seatNumber)
                .map((t) => t.seatNumber)
                .sort();

            return {
                id: order.id,
                recordLocator: order.recordLocator,
                eventId: order.eventId,
                eventName: event?.name || 'Unknown Event',
                eventDate: event?.date,
                location: event?.location || event?.venue || 'TBD',
                ticketCount: tickets.length,
                totalAmountCents: order.totalAmountCents,
                couponCode: order.couponCode,
                discountAmountCents: order.discountAmountCents,
                status: order.status,
                seatNumbers,
                seatDisplay: formatSeatDisplay(seatNumbers),
                createdAt: order.createdAt,
            };
        });

        res.json(result);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch orders' });
    }
});

// Public support report intake endpoint
app.post('/support/reports', async (req, res) => {
    try {
        const userId = getUserIdFromAuth(req);
        const {
            name,
            email,
            subject,
            description,
            pageUrl,
            userAgent,
            isBot,
        } = req.body as {
            name?: unknown;
            email?: unknown;
            subject?: unknown;
            description?: unknown;
            pageUrl?: unknown;
            userAgent?: unknown;
            isBot?: unknown;
        };

        if (typeof subject !== 'string' || typeof description !== 'string') {
            return res.status(400).json({ error: 'subject and description are required' });
        }

        const subjectValue = subject.trim().slice(0, 180);
        const descriptionValue = description.trim().slice(0, 5000);

        if (!subjectValue || !descriptionValue) {
            return res.status(400).json({ error: 'subject and description are required' });
        }

        const reportRepo = AppDataSource.getRepository(SupportReport);
        const report = reportRepo.create({
            userId,
            name: trimOptional(name, 120),
            email: trimOptional(email, 255),
            isBot: typeof isBot === 'boolean' ? isBot : false,
            subject: subjectValue,
            description: descriptionValue,
            pageUrl: trimOptional(pageUrl, 1000),
            userAgent: trimOptional(userAgent, 500) ?? trimOptional(req.get('user-agent'), 500),
        });

        await reportRepo.save(report);
        res.status(201).json({
            id: report.id,
            createdAt: report.createdAt,
            message: 'Support report submitted',
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to submit support report' });
    }
});

// Format seat numbers for display (e.g. "A-15, A-16" or "Section-Row-Seat")
function formatSeatDisplay(seatNumbers: string[]): string {
    if (seatNumbers.length === 0) return '';
    return seatNumbers.join(', ');
}

// Admin: list support reports with search, pagination, and sorting
app.get('/admin/support/reports', requireAdmin, async (req, res) => {
    try {
        const reportRepo = AppDataSource.getRepository(SupportReport);

        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
        const search = (req.query.search as string || '').toLowerCase().trim();
        const sortBy = (req.query.sortBy as string) || 'createdAt';
        const sortOrder: 'ASC' | 'DESC' =
            ((req.query.sortOrder as string) || '').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

        const allowedSortFields: Record<string, string> = {
            createdAt: 'report.createdAt',
            subject: 'report.subject',
            email: 'report.email',
            name: 'report.name',
            isBot: 'report.isBot',
        };
        const sortField = allowedSortFields[sortBy] || 'report.createdAt';

        const applyFilters = (qb: any) => {
            if (search) {
                qb.andWhere(
                    'LOWER(report.subject) LIKE :s OR LOWER(report.description) LIKE :s OR LOWER(report.name) LIKE :s OR LOWER(report.email) LIKE :s',
                    { s: `%${search}%` }
                );
            }
        };

        const countQb = reportRepo.createQueryBuilder('report');
        applyFilters(countQb);
        const total = await countQb.getCount();

        const dataQb = reportRepo.createQueryBuilder('report')
            .leftJoinAndSelect('report.user', 'user');
        applyFilters(dataQb);
        dataQb.orderBy(sortField, sortOrder).skip((page - 1) * limit).take(limit);
        const reports = await dataQb.getMany();

        const data = reports.map((report) => ({
            id: report.id,
            userId: report.userId,
            reporterName: report.user?.name || null,
            reporterEmail: report.user?.email || null,
            name: report.name,
            email: report.email,
            isBot: report.isBot,
            subject: report.subject,
            pageUrl: report.pageUrl,
            createdAt: report.createdAt,
        }));

        res.json({ data, total, page, limit, totalPages: Math.ceil(total / limit) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch support reports' });
    }
});

// Admin: get full support report details
app.get('/admin/support/reports/:id', requireAdmin, async (req, res) => {
    try {
        const reportRepo = AppDataSource.getRepository(SupportReport);
        const report = await reportRepo.findOne({
            where: { id: parseInt(req.params.id) },
            relations: ['user'],
        });

        if (!report) return res.status(404).json({ error: 'Support report not found' });

        res.json({
            id: report.id,
            userId: report.userId,
            reporterName: report.user?.name || null,
            reporterEmail: report.user?.email || null,
            name: report.name,
            email: report.email,
            isBot: report.isBot,
            subject: report.subject,
            description: report.description,
            pageUrl: report.pageUrl,
            userAgent: report.userAgent,
            createdAt: report.createdAt,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch support report details' });
    }
});

// Admin: list all events (DRAFT + PUBLISHED)
app.get('/admin/events', requireAdmin, async (req, res) => {
    try {
        const eventRepo = AppDataSource.getRepository(Event);

        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
        const search = (req.query.search as string || '').trim();
        const sortBy = (req.query.sortBy as string) || 'date';
        const sortOrder: 'ASC' | 'DESC' =
            ((req.query.sortOrder as string) || '').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

        const allowedSortFields: Record<string, string> = {
            name: 'event.name',
            date: 'event.date',
            status: 'event.status',
            createdAt: 'event.createdAt',
        };
        const sortField = allowedSortFields[sortBy] || 'event.date';

        const applyFilters = (qb: any) => {
            if (search) {
                qb.where(
                    'LOWER(event.name) LIKE :s OR LOWER(event.location) LIKE :s',
                    { s: `%${search.toLowerCase()}%` }
                );
            }
        };

        const countQb = eventRepo.createQueryBuilder('event');
        applyFilters(countQb);
        const total = await countQb.getCount();

        const dataQb = eventRepo.createQueryBuilder('event')
            .leftJoinAndSelect('event.ticketTypes', 'ticketTypes')
            .leftJoinAndSelect('event.seatMap', 'seatMap');
        applyFilters(dataQb);
        dataQb.orderBy(sortField, sortOrder).skip((page - 1) * limit).take(limit);
        const events = await dataQb.getMany();

        res.json({ data: events, total, page, limit, totalPages: Math.ceil(total / limit) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Admin: list coupon codes with search, filters, pagination, and sorting
app.get('/admin/coupons', requireAdmin, async (req, res) => {
    try {
        const couponRepo = AppDataSource.getRepository(CouponCode);

        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
        const search = (req.query.search as string || '').toLowerCase().trim();
        const activeFilter = (req.query.active as string || '').toLowerCase().trim();
        const eventIdFilter = parseInt(req.query.eventId as string);
        const sortBy = (req.query.sortBy as string) || 'code';
        const sortOrder: 'ASC' | 'DESC' =
            ((req.query.sortOrder as string) || '').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

        const allowedSortFields: Record<string, string> = {
            code: 'coupon.code',
            eventName: 'event.name',
            discountType: 'coupon.discountType',
            currentRedemptions: 'coupon.currentRedemptions',
            maxRedemptions: 'coupon.maxRedemptions',
            endsAt: 'coupon.endsAt',
            active: 'coupon.active',
        };
        const sortField = allowedSortFields[sortBy] || 'coupon.code';

        const applyFilters = (qb: any) => {
            if (activeFilter === 'true') qb.andWhere('coupon.active = true');
            if (activeFilter === 'false') qb.andWhere('coupon.active = false');
            if (Number.isInteger(eventIdFilter)) qb.andWhere('coupon.eventId = :eventId', { eventId: eventIdFilter });
            if (search) {
                qb.andWhere(
                    'LOWER(coupon.code) LIKE :s OR LOWER(COALESCE(event.name, \'\')) LIKE :s OR LOWER(COALESCE(ticketType.name, \'\')) LIKE :s',
                    { s: `%${search}%` }
                );
            }
        };

        const countQb = couponRepo.createQueryBuilder('coupon')
            .leftJoin('coupon.event', 'event')
            .leftJoin('coupon.ticketType', 'ticketType');
        applyFilters(countQb);
        const total = await countQb.getCount();

        const dataQb = couponRepo.createQueryBuilder('coupon')
            .leftJoinAndSelect('coupon.event', 'event')
            .leftJoinAndSelect('coupon.ticketType', 'ticketType');
        applyFilters(dataQb);
        dataQb.orderBy(sortField, sortOrder).addOrderBy('coupon.code', 'ASC').skip((page - 1) * limit).take(limit);
        const coupons = await dataQb.getMany();

        const data = coupons.map((coupon) => ({
            id: coupon.id,
            code: coupon.code,
            eventId: coupon.eventId,
            eventName: coupon.event?.name || null,
            ticketTypeId: coupon.ticketTypeId,
            ticketTypeName: coupon.ticketType?.name || null,
            discountType: coupon.discountType,
            percentOff: coupon.percentOff,
            amountOffCents: coupon.amountOffCents,
            active: coupon.active,
            startsAt: coupon.startsAt,
            endsAt: coupon.endsAt,
            maxRedemptions: coupon.maxRedemptions,
            currentRedemptions: coupon.currentRedemptions,
        }));

        res.json({ data, total, page, limit, totalPages: Math.ceil(total / limit) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch coupons' });
    }
});

// Admin: get one coupon code
app.get('/admin/coupons/:id', requireAdmin, async (req, res) => {
    try {
        const couponRepo = AppDataSource.getRepository(CouponCode);
        const coupon = await couponRepo.findOne({
            where: { id: parseInt(req.params.id) },
            relations: ['event', 'ticketType'],
        });

        if (!coupon) return res.status(404).json({ error: 'Coupon not found' });

        res.json({
            id: coupon.id,
            code: coupon.code,
            eventId: coupon.eventId,
            eventName: coupon.event?.name || null,
            ticketTypeId: coupon.ticketTypeId,
            ticketTypeName: coupon.ticketType?.name || null,
            discountType: coupon.discountType,
            percentOff: coupon.percentOff,
            amountOffCents: coupon.amountOffCents,
            active: coupon.active,
            startsAt: coupon.startsAt,
            endsAt: coupon.endsAt,
            maxRedemptions: coupon.maxRedemptions,
            currentRedemptions: coupon.currentRedemptions,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch coupon' });
    }
});

// Admin: create a new coupon code
app.post('/admin/coupons', requireAdmin, async (req, res) => {
    try {
        const couponRepo = AppDataSource.getRepository(CouponCode);
        const eventRepo = AppDataSource.getRepository(Event);
        const ticketTypeRepo = AppDataSource.getRepository(TicketType);

        const code = normalizeCouponCode(req.body?.code);
        const eventId = req.body?.eventId ? parseInt(String(req.body.eventId)) : null;
        const ticketTypeId = req.body?.ticketTypeId ? parseInt(String(req.body.ticketTypeId)) : null;
        const discountType = req.body?.discountType === 'AMOUNT' ? 'AMOUNT' : 'PERCENT';
        const percentOff = Math.max(0, Math.min(100, parseInt(String(req.body?.percentOff ?? 0)) || 0));
        const amountOffCents = Math.max(0, parseInt(String(req.body?.amountOffCents ?? 0)) || 0);
        const maxRedemptions = Math.max(0, parseInt(String(req.body?.maxRedemptions ?? 0)) || 0);
        const active = req.body?.active !== false;
        const startsAt = req.body?.startsAt ? new Date(req.body.startsAt) : null;
        const endsAt = req.body?.endsAt ? new Date(req.body.endsAt) : null;

        if (!code) return res.status(400).json({ error: 'Coupon code is required' });
        if (discountType === 'PERCENT' && percentOff <= 0) return res.status(400).json({ error: 'percentOff must be greater than 0' });
        if (discountType === 'AMOUNT' && amountOffCents <= 0) return res.status(400).json({ error: 'amountOffCents must be greater than 0' });
        if (startsAt && Number.isNaN(startsAt.getTime())) return res.status(400).json({ error: 'startsAt must be a valid date' });
        if (endsAt && Number.isNaN(endsAt.getTime())) return res.status(400).json({ error: 'endsAt must be a valid date' });
        if (startsAt && endsAt && startsAt > endsAt) return res.status(400).json({ error: 'startsAt must be before endsAt' });
        if (!eventId && ticketTypeId) return res.status(400).json({ error: 'eventId is required when ticketTypeId is provided' });

        if (await couponRepo.findOneBy({ code })) {
            return res.status(409).json({ error: 'Coupon code already exists' });
        }

        let event: Event | null = null;
        if (eventId) {
            event = await eventRepo.findOneBy({ id: eventId });
            if (!event) return res.status(404).json({ error: 'Event not found' });
        }

        let ticketType: TicketType | null = null;
        if (ticketTypeId) {
            ticketType = await ticketTypeRepo.findOneBy({ id: ticketTypeId, eventId: eventId as number });
            if (!ticketType) return res.status(404).json({ error: 'Ticket type not found for event' });
        }

        const coupon = couponRepo.create({
            code,
            eventId,
            ticketTypeId,
            discountType,
            percentOff: discountType === 'PERCENT' ? percentOff : 0,
            amountOffCents: discountType === 'AMOUNT' ? amountOffCents : 0,
            active,
            startsAt,
            endsAt,
            maxRedemptions,
            currentRedemptions: 0,
        });
        await couponRepo.save(coupon);

        res.status(201).json({
            ...coupon,
            eventName: event?.name || null,
            ticketTypeName: ticketType?.name || null,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create coupon' });
    }
});

// Admin: update an existing coupon code
app.patch('/admin/coupons/:id', requireAdmin, async (req, res) => {
    try {
        const couponRepo = AppDataSource.getRepository(CouponCode);
        const eventRepo = AppDataSource.getRepository(Event);
        const ticketTypeRepo = AppDataSource.getRepository(TicketType);
        const coupon = await couponRepo.findOneBy({ id: parseInt(req.params.id) });

        if (!coupon) return res.status(404).json({ error: 'Coupon not found' });

        const nextCode = req.body?.code !== undefined ? normalizeCouponCode(req.body.code) : coupon.code;
        const nextEventId = req.body?.eventId !== undefined
            ? (req.body.eventId ? parseInt(String(req.body.eventId)) : null)
            : coupon.eventId;
        const nextTicketTypeId = req.body?.ticketTypeId !== undefined
            ? (req.body.ticketTypeId ? parseInt(String(req.body.ticketTypeId)) : null)
            : coupon.ticketTypeId;
        const nextDiscountType = req.body?.discountType !== undefined
            ? (req.body.discountType === 'AMOUNT' ? 'AMOUNT' : 'PERCENT')
            : coupon.discountType;
        const nextPercentOff = req.body?.percentOff !== undefined
            ? Math.max(0, Math.min(100, parseInt(String(req.body.percentOff)) || 0))
            : coupon.percentOff;
        const nextAmountOffCents = req.body?.amountOffCents !== undefined
            ? Math.max(0, parseInt(String(req.body.amountOffCents)) || 0)
            : coupon.amountOffCents;
        const nextMaxRedemptions = req.body?.maxRedemptions !== undefined
            ? Math.max(0, parseInt(String(req.body.maxRedemptions)) || 0)
            : coupon.maxRedemptions;
        const nextCurrentRedemptions = req.body?.currentRedemptions !== undefined
            ? Math.max(0, parseInt(String(req.body.currentRedemptions)) || 0)
            : coupon.currentRedemptions;
        const nextActive = req.body?.active !== undefined ? Boolean(req.body.active) : coupon.active;
        const nextStartsAt = req.body?.startsAt !== undefined ? (req.body.startsAt ? new Date(req.body.startsAt) : null) : coupon.startsAt;
        const nextEndsAt = req.body?.endsAt !== undefined ? (req.body.endsAt ? new Date(req.body.endsAt) : null) : coupon.endsAt;

        if (!nextCode) return res.status(400).json({ error: 'Coupon code is required' });
        if (nextDiscountType === 'PERCENT' && nextPercentOff <= 0) return res.status(400).json({ error: 'percentOff must be greater than 0' });
        if (nextDiscountType === 'AMOUNT' && nextAmountOffCents <= 0) return res.status(400).json({ error: 'amountOffCents must be greater than 0' });
        if (nextStartsAt && Number.isNaN(new Date(nextStartsAt).getTime())) return res.status(400).json({ error: 'startsAt must be a valid date' });
        if (nextEndsAt && Number.isNaN(new Date(nextEndsAt).getTime())) return res.status(400).json({ error: 'endsAt must be a valid date' });
        if (nextStartsAt && nextEndsAt && new Date(nextStartsAt) > new Date(nextEndsAt)) return res.status(400).json({ error: 'startsAt must be before endsAt' });
        if (!nextEventId && nextTicketTypeId) return res.status(400).json({ error: 'eventId is required when ticketTypeId is provided' });
        if (nextCurrentRedemptions > nextMaxRedemptions && nextMaxRedemptions > 0) {
            return res.status(400).json({ error: 'currentRedemptions cannot exceed maxRedemptions' });
        }

        const existing = await couponRepo.findOneBy({ code: nextCode });
        if (existing && existing.id !== coupon.id) {
            return res.status(409).json({ error: 'Coupon code already exists' });
        }

        let event: Event | null = null;
        if (nextEventId) {
            event = await eventRepo.findOneBy({ id: nextEventId });
            if (!event) return res.status(404).json({ error: 'Event not found' });
        }

        let ticketType: TicketType | null = null;
        if (nextTicketTypeId) {
            ticketType = await ticketTypeRepo.findOneBy({ id: nextTicketTypeId, eventId: nextEventId as number });
            if (!ticketType) return res.status(404).json({ error: 'Ticket type not found for event' });
        }

        coupon.code = nextCode;
        coupon.eventId = nextEventId;
        coupon.ticketTypeId = nextTicketTypeId;
        coupon.discountType = nextDiscountType;
        coupon.percentOff = nextDiscountType === 'PERCENT' ? nextPercentOff : 0;
        coupon.amountOffCents = nextDiscountType === 'AMOUNT' ? nextAmountOffCents : 0;
        coupon.maxRedemptions = nextMaxRedemptions;
        coupon.currentRedemptions = nextCurrentRedemptions;
        coupon.active = nextActive;
        coupon.startsAt = nextStartsAt;
        coupon.endsAt = nextEndsAt;

        await couponRepo.save(coupon);

        res.json({
            ...coupon,
            eventName: event?.name || null,
            ticketTypeName: ticketType?.name || null,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update coupon' });
    }
});

// Admin: batch upsert events via external_id
app.post('/admin/events/batch', requireAdmin, async (req, res) => {
    try {
        const { events: incoming } = req.body as { events: any[] };
        if (!Array.isArray(incoming) || incoming.length === 0) {
            return res.status(400).json({ error: 'Request body must contain a non-empty "events" array' });
        }

        let created = 0;
        let updated = 0;
        let ttCreated = 0;
        let ttUpdated = 0;
        const errors: { index: number; external_id?: string; error: string }[] = [];
        const results: { index: number; status: 'created' | 'updated' }[] = [];

        await AppDataSource.manager.transaction(async (manager) => {
            const txEventRepo = manager.getRepository(Event);
            const txTtRepo = manager.getRepository(TicketType);
            const txSmRepo = manager.getRepository(SeatMap);

            for (let i = 0; i < incoming.length; i++) {
                const item = incoming[i];
                try {
                    if (!item.external_id) {
                        errors.push({ index: i, error: 'external_id is required for batch upsert' });
                        continue;
                    }
                    if (!item.name || !item.date) {
                        errors.push({ index: i, external_id: item.external_id, error: 'name and date are required' });
                        continue;
                    }

                    let event = await txEventRepo.findOne({ where: { externalId: item.external_id } });
                    const isNew = !event;

                    if (isNew) {
                        event = txEventRepo.create({ externalId: item.external_id });
                    }

                    event!.name = item.name;
                    event!.date = new Date(item.date);
                    if (item.description !== undefined) event!.description = item.description;
                    if (item.location !== undefined) event!.location = item.location;
                    if (item.image !== undefined) event!.image = item.image;
                    if (item.status !== undefined) event!.status = item.status;
                    if (item.publishAt !== undefined) event!.publishAt = item.publishAt ? new Date(item.publishAt) : null;

                    if (item.seatMapId !== undefined) {
                        if (item.seatMapId === null) {
                            event!.seatMap = null as any;
                        } else {
                            const sm = await txSmRepo
                                .createQueryBuilder('sm')
                                .where(`sm.config->>'seatMapId' = :seatMapId`, { seatMapId: item.seatMapId })
                                .getOne();
                            if (sm) event!.seatMap = sm;
                        }
                    }

                    await txEventRepo.save(event!);
                    if (isNew) created++; else updated++;

                    if (Array.isArray(item.ticketTypes)) {
                        for (const ttItem of item.ticketTypes) {
                            if (!ttItem.external_id) continue;

                            let tt = await txTtRepo.findOne({ where: { externalId: ttItem.external_id } });
                            const isNewTT = !tt;

                            if (isNewTT) {
                                tt = txTtRepo.create({ externalId: ttItem.external_id, eventId: event!.id });
                            }

                            tt!.eventId = event!.id;
                            if (ttItem.name !== undefined) tt!.name = ttItem.name;
                            if (ttItem.availabilityModel !== undefined) tt!.availabilityModel = ttItem.availabilityModel;
                            if (ttItem.pricingModel !== undefined) tt!.pricingModel = ttItem.pricingModel;
                            if (ttItem.priceCents !== undefined) tt!.priceCents = ttItem.priceCents;
                            if (ttItem.maxPerOrder !== undefined) tt!.maxPerOrder = ttItem.maxPerOrder;
                            if (ttItem.maxPerUser !== undefined) tt!.maxPerUser = ttItem.maxPerUser;
                            if (ttItem.available !== undefined) tt!.available = ttItem.available;

                            await txTtRepo.save(tt!);
                            if (isNewTT) ttCreated++; else ttUpdated++;
                        }
                    }

                    results.push({ index: i, status: isNew ? 'created' : 'updated' });
                } catch (err: any) {
                    errors.push({ index: i, external_id: item.external_id, error: err.message || 'Unknown error' });
                }
            }
        });

        const success = (created + updated) > 0;
        const status = success ? 200 : 400;
        res.status(status).json({
            success,
            events: { created, updated },
            ticketTypes: { created: ttCreated, updated: ttUpdated },
            results,
            errors,
        });
    } catch (err: any) {
        console.error('Batch upsert error:', err);
        res.status(500).json({ error: err.message || 'Failed to process batch upload' });
    }
});

// Admin: create a new event with optional scheduled publish time
// Events default to DRAFT; set publishNow:true to publish immediately
app.post('/admin/events', requireAdmin, async (req, res) => {
    try {
        const { name, description, date, location, image, publishAt, publishNow, seatMapId } = req.body as {
            name: string;
            description?: string;
            date: string;
            location?: string;
            image?: string;
            publishAt?: string;
            publishNow?: boolean;
            seatMapId?: number | null;
        };

        if (!name || !date) {
            return res.status(400).json({ error: 'name and date are required' });
        }

        const eventRepo = AppDataSource.getRepository(Event);
        const parsedPublishAt = publishAt ? new Date(publishAt) : null;
        const status = publishNow ? 'PUBLISHED' : 'DRAFT';

        const event = eventRepo.create({
            name,
            description,
            date: new Date(date),
            location,
            image,
            publishAt: parsedPublishAt,
            status,
        });

        if (seatMapId) {
            const sm = await AppDataSource.getRepository(SeatMap).findOneBy({ id: seatMapId });
            if (!sm) return res.status(400).json({ error: 'Seat map not found' });
            event.seatMap = sm;
        }

        await eventRepo.save(event);
        res.status(201).json(event);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create event' });
    }
});

// Admin: manually publish a DRAFT event immediately
app.patch('/admin/events/:id/publish', requireAdmin, async (req, res) => {
    try {
        const eventRepo = AppDataSource.getRepository(Event);
        const event = await eventRepo.findOneBy({ id: parseInt(req.params.id) });
        if (!event) return res.status(404).json({ error: 'Event not found' });
        event.status = 'PUBLISHED';
        event.publishAt = null;
        await eventRepo.save(event);
        res.json({ success: true, event });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to publish event' });
    }
});

// Admin: update an existing event (partial update)
app.patch('/admin/events/:id', requireAdmin, async (req, res) => {
    try {
        const eventRepo = AppDataSource.getRepository(Event);
        const event = await eventRepo.findOneBy({ id: parseInt(req.params.id) });
        if (!event) return res.status(404).json({ error: 'Event not found' });

        const { name, description, date, location, image, publishAt, status, seatMapId } = req.body as {
            name?: string;
            description?: string;
            date?: string;
            location?: string;
            image?: string;
            publishAt?: string | null;
            status?: string;
            seatMapId?: number | null;
        };

        if (name !== undefined) event.name = name;
        if (description !== undefined) event.description = description;
        if (date !== undefined) event.date = new Date(date);
        if (location !== undefined) event.location = location;
        if (image !== undefined) event.image = image;
        if (publishAt !== undefined) event.publishAt = publishAt ? new Date(publishAt) : null;
        if (status !== undefined) event.status = status;

        if (seatMapId !== undefined) {
            if (seatMapId === null) {
                event.seatMap = null as any;
            } else {
                const sm = await AppDataSource.getRepository(SeatMap).findOneBy({ id: seatMapId });
                if (!sm) return res.status(400).json({ error: 'Seat map not found' });
                event.seatMap = sm;
            }
        }

        await eventRepo.save(event);
        res.json({ success: true, event });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update event' });
    }
});

// Admin: list all orders with search, status filter, pagination, and sorting
app.get('/admin/orders', requireAdmin, async (req, res) => {
    try {
        const orderRepo = AppDataSource.getRepository(Order);

        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
        const search = (req.query.search as string || '').toLowerCase().trim();
        const statusFilter = (req.query.status as string || '').toLowerCase().trim();
        const sortBy = (req.query.sortBy as string) || 'createdAt';
        const sortOrder: 'ASC' | 'DESC' =
            ((req.query.sortOrder as string) || '').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

        const allowedSortFields: Record<string, string> = {
            recordLocator: 'order.recordLocator',
            userName: 'user.name',
            eventName: 'event.name',
            amount: 'order.totalAmountCents',
            status: 'order.status',
            createdAt: 'order.createdAt',
        };
        const sortField = allowedSortFields[sortBy] || 'order.createdAt';

        const applyFilters = (qb: any) => {
            if (statusFilter) qb.andWhere('order.status = :status', { status: statusFilter });
            if (search) {
                qb.andWhere(
                    'LOWER(order.recordLocator) LIKE :s OR LOWER(user.email) LIKE :s OR LOWER(user.name) LIKE :s OR LOWER(event.name) LIKE :s',
                    { s: `%${search}%` }
                );
            }
        };

        const countQb = orderRepo.createQueryBuilder('order')
            .leftJoin('order.user', 'user')
            .leftJoin('order.event', 'event');
        applyFilters(countQb);
        const total = await countQb.getCount();

        const dataQb = orderRepo.createQueryBuilder('order')
            .leftJoinAndSelect('order.user', 'user')
            .leftJoinAndSelect('order.event', 'event')
            .leftJoinAndSelect('order.tickets', 'tickets');
        applyFilters(dataQb);
        dataQb.orderBy(sortField, sortOrder).skip((page - 1) * limit).take(limit);
        const orders = await dataQb.getMany();

        const data = orders.map(order => ({
            id: order.id,
            recordLocator: order.recordLocator,
            userId: order.userId,
            userName: order.user?.name || null,
            userEmail: order.user?.email || null,
            eventId: order.eventId,
            eventName: order.event?.name || null,
            ticketCount: order.tickets?.length || 0,
            totalAmountCents: order.totalAmountCents,
            couponCode: order.couponCode,
            discountAmountCents: order.discountAmountCents,
            paymentTransactionId: order.paymentTransactionId,
            status: order.status,
            fulfillmentStatus: order.fulfillmentStatus,
            createdAt: order.createdAt,
        }));

        res.json({ data, total, page, limit, totalPages: Math.ceil(total / limit) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch orders' });
    }
});

// Admin: get a single order with full details
app.get('/admin/orders/:id', requireAdmin, async (req, res) => {
    try {
        const orderRepo = AppDataSource.getRepository(Order);
        const order = await orderRepo.findOne({
            where: { id: parseInt(req.params.id) },
            relations: ['user', 'event', 'tickets'],
        });
        if (!order) return res.status(404).json({ error: 'Order not found' });

        const tickets = (order.tickets || []).map(t => ({
            id: t.id,
            seatNumber: t.seatNumber,
            status: t.status,
        }));

        res.json({
            id: order.id,
            recordLocator: order.recordLocator,
            userId: order.userId,
            userName: order.user?.name || null,
            userEmail: order.user?.email || null,
            eventId: order.eventId,
            eventName: order.event?.name || null,
            eventDate: order.event?.date || null,
            eventLocation: order.event?.location || null,
            totalAmountCents: order.totalAmountCents,
            couponCode: order.couponCode,
            discountAmountCents: order.discountAmountCents,
            paymentTransactionId: order.paymentTransactionId,
            status: order.status,
            fulfillmentStatus: order.fulfillmentStatus,
            createdAt: order.createdAt,
            tickets,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch order' });
    }
});

// Admin: cancel an order — marks order + tickets as cancelled, sends email
app.post('/admin/orders/:id/cancel', requireAdmin, async (req, res) => {
    try {
        const orderRepo = AppDataSource.getRepository(Order);
        const ticketRepo = AppDataSource.getRepository(Ticket);
        const ticketTypeRepo = AppDataSource.getRepository(TicketType);
        const order = await orderRepo.findOne({
            where: { id: parseInt(req.params.id) },
            relations: ['user', 'event', 'tickets'],
        });
        if (!order) return res.status(404).json({ error: 'Order not found' });
        if (order.status === 'cancelled') return res.status(400).json({ error: 'Order is already cancelled' });

        order.status = 'cancelled';
        order.fulfillmentStatus = 'cancelled';
        await orderRepo.save(order);

        if (order.tickets && order.tickets.length > 0) {
            await ticketRepo.update(
                { id: In(order.tickets.map(t => t.id)) },
                { status: 'cancelled' }
            );

            const generalAdmissionTicketCount = order.tickets.filter((ticket) => !ticket.seatNumber).length;
            if (generalAdmissionTicketCount > 0) {
                const ticketTypes = await ticketTypeRepo.find({
                    where: { eventId: order.eventId },
                    order: { priceCents: 'ASC', id: 'ASC' },
                });
                const defaultTicketType = ticketTypes.find((ticketType) => ticketType.availabilityModel === 'GA_POOL');

                if (defaultTicketType) {
                    defaultTicketType.available += generalAdmissionTicketCount;
                    await ticketTypeRepo.save(defaultTicketType);
                }
            }
        }

        if (order.user?.email) {
            sendCancellationEmail(order.user.email, {
                name: order.user.name,
                recordLocator: order.recordLocator,
                eventName: order.event?.name || 'Unknown Event',
                refundAmountCents: order.totalAmountCents,
                reason: req.body?.reason || 'Cancelled by administrator',
            });
        }

        res.json({ success: true, message: `Order ${order.recordLocator} cancelled.` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to cancel order' });
    }
});

// Admin: create a ticket type for an event
app.post('/admin/events/:id/ticket-types', requireAdmin, async (req, res) => {
    try {
        const eventId = parseInt(req.params.id);
        if (!Number.isInteger(eventId)) {
            return res.status(400).json({ error: 'Invalid event id' });
        }
        const eventRepo = AppDataSource.getRepository(Event);
        const event = await eventRepo.findOneBy({ id: eventId });
        if (!event) return res.status(404).json({ error: 'Event not found' });

        const ttRepo = AppDataSource.getRepository(TicketType);
        const { name, availabilityModel, pricingModel, priceCents, maxPerOrder, maxPerUser, available } = req.body;

        if (!name) return res.status(400).json({ error: 'name is required' });

        const tt = ttRepo.create({
            eventId,
            name,
            availabilityModel: availabilityModel || 'GA_POOL',
            pricingModel: pricingModel || 'FREE',
            priceCents: priceCents || 0,
            maxPerOrder: maxPerOrder || 0,
            maxPerUser: maxPerUser || 0,
            available: available || 0,
        });
        await ttRepo.save(tt);
        res.status(201).json(tt);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create ticket type' });
    }
});

// Admin: update a ticket type
app.patch('/admin/events/:id/ticket-types/:typeId', requireAdmin, async (req, res) => {
    try {
        const ttRepo = AppDataSource.getRepository(TicketType);
        const tt = await ttRepo.findOneBy({ id: parseInt(req.params.typeId), eventId: parseInt(req.params.id) });
        if (!tt) return res.status(404).json({ error: 'Ticket type not found' });

        const { name, availabilityModel, pricingModel, priceCents, maxPerOrder, maxPerUser, available } = req.body;
        if (name !== undefined) tt.name = name;
        if (availabilityModel !== undefined) tt.availabilityModel = availabilityModel;
        if (pricingModel !== undefined) tt.pricingModel = pricingModel;
        if (priceCents !== undefined) tt.priceCents = priceCents;
        if (maxPerOrder !== undefined) tt.maxPerOrder = maxPerOrder;
        if (maxPerUser !== undefined) tt.maxPerUser = maxPerUser;
        if (available !== undefined) tt.available = available;

        await ttRepo.save(tt);
        res.json(tt);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update ticket type' });
    }
});

// Admin: delete a ticket type
app.delete('/admin/events/:id/ticket-types/:typeId', requireAdmin, async (req, res) => {
    try {
        const ttRepo = AppDataSource.getRepository(TicketType);
        const tt = await ttRepo.findOneBy({ id: parseInt(req.params.typeId), eventId: parseInt(req.params.id) });
        if (!tt) return res.status(404).json({ error: 'Ticket type not found' });

        await ttRepo.remove(tt);
        res.json({ success: true, message: `Ticket type "${tt.name}" deleted.` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete ticket type' });
    }
});

// Admin: list all seat maps (without full config for list view)
app.get('/admin/seat-maps', requireAdmin, async (req, res) => {
    try {
        const smRepo = AppDataSource.getRepository(SeatMap);
        const seatMaps = await smRepo.find({ relations: ['events'] });

        const result = seatMaps.map(sm => ({
            id: sm.id,
            name: sm.name,
            eventCount: sm.events?.length || 0,
            events: (sm.events || []).map(e => ({ id: e.id, name: e.name })),
        }));

        res.json(result);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch seat maps' });
    }
});

// Admin: get a single seat map with full config
app.get('/admin/seat-maps/:id', requireAdmin, async (req, res) => {
    try {
        const smRepo = AppDataSource.getRepository(SeatMap);
        const sm = await smRepo.findOne({
            where: { id: parseInt(req.params.id) },
            relations: ['events'],
        });
        if (!sm) return res.status(404).json({ error: 'Seat map not found' });

        res.json({
            id: sm.id,
            name: sm.name,
            config: sm.config,
            events: (sm.events || []).map(e => ({ id: e.id, name: e.name, date: e.date, location: e.location })),
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch seat map' });
    }
});

// Admin: create a new seat map
app.post('/admin/seat-maps', requireAdmin, async (req, res) => {
    try {
        const { name, config } = req.body as { name?: string; config?: any };
        if (!name || !name.trim()) {
            return res.status(400).json({ error: 'Seat map name is required' });
        }
        if (!config || !Array.isArray(config.sections) || config.sections.length === 0) {
            return res.status(400).json({ error: 'config.sections must be a non-empty array' });
        }

        const smRepo = AppDataSource.getRepository(SeatMap);
        const sm = smRepo.create({ name: name.trim(), config });
        await smRepo.save(sm);

        res.status(201).json({ id: sm.id, name: sm.name, config: sm.config });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create seat map' });
    }
});

// Admin: batch upsert seat maps by stable config.seatMapId
app.post('/admin/seat-maps/batch', requireAdmin, async (req, res) => {
    try {
        const { seatMaps: incoming } = req.body as { seatMaps: any[] };
        if (!Array.isArray(incoming) || incoming.length === 0) {
            return res.status(400).json({ error: 'Request body must contain a non-empty "seatMaps" array' });
        }

        const smRepo = AppDataSource.getRepository(SeatMap);
        let created = 0;
        let updated = 0;
        const errors: { index: number; name?: string; error: string }[] = [];
        const results: { index: number; id: number; name: string; status: 'created' | 'updated' }[] = [];

        for (let i = 0; i < incoming.length; i++) {
            const item = incoming[i];
            try {
                const externalId = item.config?.seatMapId;
                if (typeof externalId !== 'string' || !externalId.trim()) {
                    errors.push({ index: i, name: item.name, error: 'config.seatMapId is required' });
                    continue;
                }
                if (!item.name || !item.name.trim()) {
                    errors.push({ index: i, error: 'name is required' });
                    continue;
                }
                if (!item.config || !Array.isArray(item.config.sections) || item.config.sections.length === 0) {
                    errors.push({ index: i, name: item.name, error: 'config.sections must be a non-empty array' });
                    continue;
                }

                let sm = await smRepo
                    .createQueryBuilder('sm')
                    .where(`sm.config->>'seatMapId' = :externalId`, { externalId })
                    .getOne();
                const isNew = !sm;

                if (isNew) {
                    sm = smRepo.create({
                        name: item.name.trim(),
                        config: item.config,
                    });
                }

                sm!.name = item.name.trim();
                sm!.config = item.config;

                await smRepo.save(sm!);
                results.push({ index: i, id: sm!.id, name: sm!.name, status: isNew ? 'created' : 'updated' });
                if (isNew) created++; else updated++;
            } catch (err: any) {
                errors.push({ index: i, name: item.name, error: err.message || 'Unknown error' });
            }
        }

        res.json({
            success: (created + updated) > 0,
            seatMaps: { created, updated },
            results,
            errors,
        });
    } catch (err: any) {
        console.error('Batch seat map upsert error:', err);
        res.status(500).json({ error: err.message || 'Failed to process batch seat map upload' });
    }
});

// Admin: delete a seat map (only if no events reference it)
app.delete('/admin/seat-maps/:id', requireAdmin, async (req, res) => {
    try {
        const smRepo = AppDataSource.getRepository(SeatMap);
        const sm = await smRepo.findOne({
            where: { id: parseInt(req.params.id) },
            relations: ['events'],
        });
        if (!sm) return res.status(404).json({ error: 'Seat map not found' });

        if (sm.events && sm.events.length > 0) {
            return res.status(409).json({
                error: `Cannot delete seat map — it is used by ${sm.events.length} event(s)`,
                events: sm.events.map(e => ({ id: e.id, name: e.name })),
            });
        }

        await smRepo.remove(sm);
        res.json({ message: 'Seat map deleted' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete seat map' });
    }
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
    console.log(`Ticket Service running on port ${PORT}`);
});
