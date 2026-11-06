// Peer registry of the in-game relay hub.
//
// Tracks which remote clients (relay and debug LAN) are attached and which
// interests they hold. The SQF requests a registry change implies are sent
// through the narrow outbox, so this module never needs the full
// `RelayNetworking` surface.

/** A relay client as announced by the relay. */
export type RelayPeer = {
    id: string;
    label: string;
    via: string;
    connectedAt: string;
    firstSeenAt: string;
};

/** The fire-and-forget `main` requests the peer registry can trigger. */
export interface RelayPeerOutbox {
    send(data: object): Promise<object>;
}

export class RelayPeers {
    private readonly peers = new Map<string, RelayPeer>();
    private readonly lanClients = new Set<string>();
    private readonly interestClients = new Map<string, Set<string>>();
    private readonly announcedInterests = new Set<string>();
    private readonly outbox: RelayPeerOutbox;

    constructor(outbox: RelayPeerOutbox) {
        this.outbox = outbox;
    }

    registerRelayPeer(peer: RelayPeer): void {
        this.peers.set(peer.id, peer);
    }

    removeRelayPeer(id: string): boolean {
        return this.peers.delete(id);
    }

    clearRelayPeers(): void {
        this.peers.clear();
    }

    relayPeerIds(): string[] {
        return [...this.peers.keys()];
    }

    /** Snapshots of the current relay peers, in registry order. */
    relayPeers(): RelayPeer[] {
        return [...this.peers.values()];
    }

    addLanClient(clientId: string): void {
        this.lanClients.add(clientId);
    }

    removeLanClient(clientId: string): boolean {
        return this.lanClients.delete(clientId);
    }

    hasLanClient(clientId: string): boolean {
        return this.lanClients.has(clientId);
    }

    lanClientsCount(): number {
        return this.lanClients.size;
    }

    /** Every attached client that is not the in-game page itself. */
    remoteInterestClients(): Set<string> {
        const clients = new Set<string>();
        for (const set of this.interestClients.values()) {
            for (const clientId of set) {
                if (clientId !== "local") clients.add(clientId);
            }
        }
        return clients;
    }

    applyInterest(clientId: string, interest: string, active: boolean): void {
        if (active) {
            let clients = this.interestClients.get(interest);
            if (!clients) {
                clients = new Set<string>();
                this.interestClients.set(interest, clients);
            }

            const wasEmpty = clients.size === 0;
            clients.add(clientId);

            if (wasEmpty && !this.announcedInterests.has(interest)) {
                this.announcedInterests.add(interest);
                this.sendInterest(interest, true);
            }

            return;
        }

        const clients = this.interestClients.get(interest);
        if (!clients || !clients.delete(clientId)) return;

        if (clients.size === 0) {
            this.interestClients.delete(interest);
            if (this.announcedInterests.delete(interest)) {
                this.sendInterest(interest, false);
            }
        }
    }

    clearClientInterests(clientId: string): void {
        for (const [interest, clients] of [...this.interestClients]) {
            if (!clients.delete(clientId)) continue;

            if (clients.size === 0) {
                this.interestClients.delete(interest);
                if (this.announcedInterests.delete(interest)) {
                    this.sendInterest(interest, false);
                }
            }
        }
    }

    private sendInterest(interest: string, active: boolean): void {
        // `Interest.Clear` in SQF clears every interest for the client, which
        // would deactivate the other interests this hub still has active.
        // Use Interest.Set with active:false for one interest at a time.
        void this.outbox.send({
            a: "main",
            c: "Interest.Set",
            interest,
            active,
        }).catch((error) => {
            console.warn("[TacPhone] Could not update an aggregated interest:", error);
        });
    }
}
