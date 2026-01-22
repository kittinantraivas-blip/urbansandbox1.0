import { Behaviour, GameObject, serializable } from "@needle-tools/engine";
import { Object3D, Vector3, Quaternion, Matrix4 } from "three";
import { WebXRImageTracking } from "@needle-tools/engine";
import { WebARSessionRoot } from "@needle-tools/engine";
import { RoomEvents } from "@needle-tools/engine";
import { InstantiateIdProvider } from "@needle-tools/engine";

// ============================================================================
// Types & Interfaces
// ============================================================================

interface TrackedImageSpawnMessage {
    senderId: string;
    imageId: string;
    assetIndex: number;
    relativePosition: { x: number; y: number; z: number };
    relativeRotation: { x: number; y: number; z: number; w: number };
    timestamp: number;
}

interface TrackedImageTransformMessage {
    senderId: string;
    imageId: string;
    relativePosition: { x: number; y: number; z: number };
    relativeRotation: { x: number; y: number; z: number; w: number };
    timestamp: number;
}

interface TrackedImageDespawnMessage {
    senderId: string;
    imageId: string;
    timestamp: number;
}

interface TrackedImageOwnershipMessage {
    senderId: string;
    imageId: string;
    action: "request" | "release";
    timestamp: number;
}

interface SyncedTrackedObject {
    object: Object3D;
    ownerId: string;
    assetIndex: number;
    lastUpdate: number;
    isLocallyTracked: boolean;
}

// ============================================================================
// Network Message Types
// ============================================================================

const MSG_TRACKED_IMAGE_SPAWN = "tracked-image-spawn";
const MSG_TRACKED_IMAGE_TRANSFORM = "tracked-image-transform";
const MSG_TRACKED_IMAGE_DESPAWN = "tracked-image-despawn";
const MSG_TRACKED_IMAGE_OWNERSHIP = "tracked-image-ownership";
const MSG_TRACKED_IMAGE_STATE_REQUEST = "tracked-image-state-request";
const MSG_TRACKED_IMAGE_STATE_RESPONSE = "tracked-image-state-response";

const debug = false;

// ============================================================================
// Main Component
// ============================================================================

/**
 * NetworkedImageTrackingSync synchronizes image-tracked objects across all connected users.
 * 
 * When one user tracks an image card, all other users in the same room will see
 * the corresponding 3D model appear at the same position relative to the Sandbox.
 * 
 * @category Networking
 * @category XR
 */
export class NetworkedImageTrackingSync extends Behaviour {

    // ========================================================================
    // Serialized Properties - These will appear in Unity Inspector
    // ========================================================================

    /**
     * Reference to the WebXRImageTracking component.
     * Drag the GameObject containing WebXRImageTracking here.
     */
    @serializable(WebXRImageTracking)
    imageTracking: WebXRImageTracking | null = null;

    /**
     * Reference to the Sandbox root (Content with WebARSessionRoot).
     * Drag the Content GameObject here.
     */
    @serializable(Object3D)
    sandboxRoot: Object3D | null = null;

    /**
     * Interval (ms) between transform updates. Lower = smoother but more traffic.
     */
    @serializable()
    updateInterval: number = 50;

    /**
     * Interpolation factor for smooth movement (0-1).
     */
    @serializable()
    interpolationFactor: number = 0.3;

    // ========================================================================
    // Private State
    // ========================================================================

    private syncedObjects: Map<string, SyncedTrackedObject> = new Map();
    private lastUpdateTime: number = 0;
    private sandboxInverseMatrix: Matrix4 = new Matrix4();
    private tempVec3: Vector3 = new Vector3();
    private tempQuat: Quaternion = new Quaternion();
    private tempQuat2: Quaternion = new Quaternion();

    // Bound handlers
    private boundOnImageTracking: any;
    private boundOnReceiveSpawn: any;
    private boundOnReceiveTransform: any;
    private boundOnReceiveDespawn: any;
    private boundOnReceiveOwnership: any;
    private boundOnReceiveStateRequest: any;
    private boundOnReceiveStateResponse: any;
    private boundOnUserJoined: any;
    private boundOnUserLeft: any;

    // ========================================================================
    // Lifecycle
    // ========================================================================

    awake(): void {
        this.syncedObjects = new Map();
        
        // Bind handlers
        this.boundOnImageTracking = this.onImageTrackingUpdate.bind(this);
        this.boundOnReceiveSpawn = this.onReceiveSpawn.bind(this);
        this.boundOnReceiveTransform = this.onReceiveTransform.bind(this);
        this.boundOnReceiveDespawn = this.onReceiveDespawn.bind(this);
        this.boundOnReceiveOwnership = this.onReceiveOwnership.bind(this);
        this.boundOnReceiveStateRequest = this.onReceiveStateRequest.bind(this);
        this.boundOnReceiveStateResponse = this.onReceiveStateResponse.bind(this);
        this.boundOnUserJoined = this.onUserJoined.bind(this);
        this.boundOnUserLeft = this.onUserLeft.bind(this);
        
        if (debug) console.log("[NetworkedImageTrackingSync] Awake", this);
    }

    onEnable(): void {
        // Subscribe to image tracking
        if (this.imageTracking) {
            this.imageTracking.addEventListener("image-tracking", this.boundOnImageTracking);
            if (debug) console.log("[NetworkedImageTrackingSync] Subscribed to imageTracking");
        } else {
            console.warn("[NetworkedImageTrackingSync] imageTracking is not assigned!");
        }

        if (!this.sandboxRoot) {
            console.warn("[NetworkedImageTrackingSync] sandboxRoot is not assigned!");
        }

        // Subscribe to network
        const conn = this.context.connection;
        conn.beginListen(MSG_TRACKED_IMAGE_SPAWN, this.boundOnReceiveSpawn);
        conn.beginListen(MSG_TRACKED_IMAGE_TRANSFORM, this.boundOnReceiveTransform);
        conn.beginListen(MSG_TRACKED_IMAGE_DESPAWN, this.boundOnReceiveDespawn);
        conn.beginListen(MSG_TRACKED_IMAGE_OWNERSHIP, this.boundOnReceiveOwnership);
        conn.beginListen(MSG_TRACKED_IMAGE_STATE_REQUEST, this.boundOnReceiveStateRequest);
        conn.beginListen(MSG_TRACKED_IMAGE_STATE_RESPONSE, this.boundOnReceiveStateResponse);
        conn.beginListen(RoomEvents.JoinedRoom, this.boundOnUserJoined);
        conn.beginListen(RoomEvents.UserLeftRoom, this.boundOnUserLeft);

        if (debug) console.log("[NetworkedImageTrackingSync] Enabled");
    }

    onDisable(): void {
        if (this.imageTracking) {
            this.imageTracking.removeEventListener("image-tracking", this.boundOnImageTracking);
        }

        const conn = this.context.connection;
        conn.stopListen(MSG_TRACKED_IMAGE_SPAWN, this.boundOnReceiveSpawn);
        conn.stopListen(MSG_TRACKED_IMAGE_TRANSFORM, this.boundOnReceiveTransform);
        conn.stopListen(MSG_TRACKED_IMAGE_DESPAWN, this.boundOnReceiveDespawn);
        conn.stopListen(MSG_TRACKED_IMAGE_OWNERSHIP, this.boundOnReceiveOwnership);
        conn.stopListen(MSG_TRACKED_IMAGE_STATE_REQUEST, this.boundOnReceiveStateRequest);
        conn.stopListen(MSG_TRACKED_IMAGE_STATE_RESPONSE, this.boundOnReceiveStateResponse);
        conn.stopListen(RoomEvents.JoinedRoom, this.boundOnUserJoined);
        conn.stopListen(RoomEvents.UserLeftRoom, this.boundOnUserLeft);

        this.despawnAllLocallyTracked();
        if (debug) console.log("[NetworkedImageTrackingSync] Disabled");
    }

    onDestroy(): void {
        for (const [imageId, data] of this.syncedObjects) {
            if (data.object) {
                data.object.removeFromParent();
                GameObject.destroy(data.object);
            }
        }
        this.syncedObjects.clear();
    }

    // ========================================================================
    // Image Tracking Handler
    // ========================================================================

    private onImageTrackingUpdate(event: CustomEvent): void {
        if (!this.canSync()) return;

        const images = event.detail;
        if (!images || images.length === 0) return;

        const now = Date.now();
        const shouldSendUpdate = (now - this.lastUpdateTime) >= this.updateInterval;

        for (const image of images) {
            const imageId = this.getImageId(image);
            const assetIndex = this.getAssetIndex(image);

            const relativeTransform = this.calculateRelativeTransform(image);
            if (!relativeTransform) continue;

            const existingData = this.syncedObjects.get(imageId);

            if (!existingData) {
                // First time - send spawn
                this.sendSpawnMessage(imageId, assetIndex, relativeTransform);
                if (debug) console.log(`[NetworkedImageTrackingSync] New tracked: ${imageId}`);
            } 
            else if (existingData.isLocallyTracked && shouldSendUpdate) {
                // We own - send transform
                this.sendTransformMessage(imageId, relativeTransform);
            }
            else if (!existingData.isLocallyTracked && existingData.ownerId !== this.getLocalId()) {
                // Request ownership
                this.requestOwnership(imageId);
            }
        }

        if (shouldSendUpdate) {
            this.lastUpdateTime = now;
        }

        this.checkForLostTracking(images);
    
    }

    private checkForLostTracking(currentImages: any[]): void {
        const currentIds = new Set(currentImages.map(img => this.getImageId(img)));

        for (const [imageId, data] of this.syncedObjects) {
            if (data.isLocallyTracked && !currentIds.has(imageId)) {
                if (debug) console.log(`[NetworkedImageTrackingSync] Lost: ${imageId}`);
                this.releaseOwnership(imageId);
                this.sendDespawnMessage(imageId);
                this.removeTrackedObject(imageId);
            }
        }
    }

    // ========================================================================
    // Network Senders
    // ========================================================================

    private sendSpawnMessage(imageId: string, assetIndex: number, transform: { position: Vector3; rotation: Quaternion }): void {
        const message: TrackedImageSpawnMessage = {
            senderId: this.getLocalId(),
            imageId,
            assetIndex,
            relativePosition: { x: transform.position.x, y: transform.position.y, z: transform.position.z },
            relativeRotation: { x: transform.rotation.x, y: transform.rotation.y, z: transform.rotation.z, w: transform.rotation.w },
            timestamp: Date.now()
        };
        this.context.connection.send(MSG_TRACKED_IMAGE_SPAWN, message);
        if (debug) console.log(`[NetworkedImageTrackingSync] Sent spawn: ${imageId}`);
    }

    private sendTransformMessage(imageId: string, transform: { position: Vector3; rotation: Quaternion }): void {
        const message: TrackedImageTransformMessage = {
            senderId: this.getLocalId(),
            imageId,
            relativePosition: { x: transform.position.x, y: transform.position.y, z: transform.position.z },
            relativeRotation: { x: transform.rotation.x, y: transform.rotation.y, z: transform.rotation.z, w: transform.rotation.w },
            timestamp: Date.now()
        };
        this.context.connection.send(MSG_TRACKED_IMAGE_TRANSFORM, message);
    }

    private sendDespawnMessage(imageId: string): void {
        const message: TrackedImageDespawnMessage = {
            senderId: this.getLocalId(),
            imageId,
            timestamp: Date.now()
        };
        this.context.connection.send(MSG_TRACKED_IMAGE_DESPAWN, message);
        if (debug) console.log(`[NetworkedImageTrackingSync] Sent despawn: ${imageId}`);
    }

    private requestOwnership(imageId: string): void {
        const message: TrackedImageOwnershipMessage = {
            senderId: this.getLocalId(),
            imageId,
            action: "request",
            timestamp: Date.now()
        };
        this.context.connection.send(MSG_TRACKED_IMAGE_OWNERSHIP, message);
    }

    private releaseOwnership(imageId: string): void {
        const message: TrackedImageOwnershipMessage = {
            senderId: this.getLocalId(),
            imageId,
            action: "release",
            timestamp: Date.now()
        };
        this.context.connection.send(MSG_TRACKED_IMAGE_OWNERSHIP, message);
    }

    // ========================================================================
    // Network Receivers
    // ========================================================================

    private onReceiveSpawn(message: TrackedImageSpawnMessage): void {
        if (debug) console.log(`[NetworkedImageTrackingSync] Received spawn:`, message);

        const existingData = this.syncedObjects.get(message.imageId);
        if (existingData) {
            if (message.timestamp < existingData.lastUpdate) {
                existingData.ownerId = message.senderId;
                existingData.isLocallyTracked = message.senderId === this.getLocalId();
            }
            return;
        }

        this.createTrackedObject(message);
    }

    private onReceiveTransform(message: TrackedImageTransformMessage): void {
        const data = this.syncedObjects.get(message.imageId);
        if (!data) return;
        if (message.senderId !== data.ownerId) return;
        if (message.senderId === this.getLocalId() && data.isLocallyTracked) return;
        if (message.timestamp < data.lastUpdate) return;

        this.applyRelativeTransform(data.object, message.relativePosition, message.relativeRotation);
        data.lastUpdate = message.timestamp;
    }

    private onReceiveDespawn(message: TrackedImageDespawnMessage): void {
        if (debug) console.log(`[NetworkedImageTrackingSync] Received despawn:`, message);

        const data = this.syncedObjects.get(message.imageId);
        if (!data) return;
        if (message.senderId !== data.ownerId) return;

        this.removeTrackedObject(message.imageId);
    }

    private onReceiveOwnership(message: TrackedImageOwnershipMessage): void {
        const data = this.syncedObjects.get(message.imageId);
        if (!data) return;

        if (message.action === "request") {
            if (!data.isLocallyTracked || data.ownerId !== this.getLocalId()) {
                data.ownerId = message.senderId;
                data.isLocallyTracked = message.senderId === this.getLocalId();
            }
        } else if (message.action === "release") {
            if (data.ownerId === message.senderId) {
                data.ownerId = "";
            }
        }
    }

    private onReceiveStateRequest(message: { senderId: string }): void {
        if (message.senderId === this.getLocalId()) return;

        for (const [imageId, data] of this.syncedObjects) {
            if (data.isLocallyTracked && data.object) {
                const transform = this.calculateRelativeTransformFromObject(data.object);
                if (transform) {
                    this.context.connection.send(MSG_TRACKED_IMAGE_STATE_RESPONSE, {
                        targetId: message.senderId,
                        imageId,
                        assetIndex: data.assetIndex,
                        ownerId: data.ownerId,
                        relativePosition: { x: transform.position.x, y: transform.position.y, z: transform.position.z },
                        relativeRotation: { x: transform.rotation.x, y: transform.rotation.y, z: transform.rotation.z, w: transform.rotation.w },
                        timestamp: Date.now()
                    });
                }
            }
        }
    }

    private onReceiveStateResponse(message: any): void {
        if (message.targetId && message.targetId !== this.getLocalId()) return;

        if (!this.syncedObjects.has(message.imageId)) {
            this.createTrackedObject({
                senderId: message.ownerId,
                imageId: message.imageId,
                assetIndex: message.assetIndex,
                relativePosition: message.relativePosition,
                relativeRotation: message.relativeRotation,
                timestamp: message.timestamp
            });
        }
    }

    private onUserJoined(data: { userId: string }): void {
        if (data.userId === this.getLocalId()) {
            this.context.connection.send(MSG_TRACKED_IMAGE_STATE_REQUEST, {
                senderId: this.getLocalId()
            });
        }
    }

    private onUserLeft(data: { userId: string }): void {
        for (const [imageId, objData] of this.syncedObjects) {
            if (objData.ownerId === data.userId) {
                this.removeTrackedObject(imageId);
            }
        }
    }

    // ========================================================================
    // Object Management
    // ========================================================================

    private async createTrackedObject(message: TrackedImageSpawnMessage): Promise<void> {
        if (!this.imageTracking?.trackedImages) return;

        const trackedImageModel = this.imageTracking.trackedImages[message.assetIndex];
        if (!trackedImageModel?.object) {
            console.warn(`[NetworkedImageTrackingSync] No asset at index ${message.assetIndex}`);
            return;
        }

        try {
            const asset = await trackedImageModel.object.loadAssetAsync();
            if (!asset) return;

            const idProvider = new InstantiateIdProvider(message.imageId);
            const instance = GameObject.instantiate(asset, { idProvider, keepWorldPosition: false });
            if (!instance) return;

            // Parent to sandbox
            if (this.sandboxRoot) {
                this.sandboxRoot.add(instance);
            } else {
                this.context.scene.add(instance);
            }

            // Apply transform
            this.applyRelativeTransform(instance, message.relativePosition, message.relativeRotation);

            // Store
            this.syncedObjects.set(message.imageId, {
                object: instance,
                ownerId: message.senderId,
                assetIndex: message.assetIndex,
                lastUpdate: message.timestamp,
                isLocallyTracked: message.senderId === this.getLocalId()
            });

            GameObject.setActive(instance, true);
            if (debug) console.log(`[NetworkedImageTrackingSync] Created: ${message.imageId}`);

        } catch (error) {
            console.error(`[NetworkedImageTrackingSync] Error:`, error);
        }
    }

    private removeTrackedObject(imageId: string): void {
        const data = this.syncedObjects.get(imageId);
        if (!data) return;

        if (data.object) {
            data.object.removeFromParent();
            GameObject.destroy(data.object);
        }
        this.syncedObjects.delete(imageId);
        if (debug) console.log(`[NetworkedImageTrackingSync] Removed: ${imageId}`);
    }

    private despawnAllLocallyTracked(): void {
        for (const [imageId, data] of this.syncedObjects) {
            if (data.isLocallyTracked) {
                this.sendDespawnMessage(imageId);
            }
        }
    }

    // ========================================================================
    // Coordinate Transform
    // ========================================================================

    private calculateRelativeTransform(image: any): { position: Vector3; rotation: Quaternion } | null {
        if (!this.sandboxRoot) return null;

        const worldPos = new Vector3();
        const worldRot = new Quaternion();

        // ใช้ API ที่มีจริงใน WebXRTrackedImage
        image.getPosition(worldPos);
        image.getQuaternion(worldRot);

        this.sandboxRoot.updateWorldMatrix(true, false);
        this.sandboxInverseMatrix.copy(this.sandboxRoot.matrixWorld).invert();

        const relativePos = worldPos.applyMatrix4(this.sandboxInverseMatrix);

        this.sandboxRoot.getWorldQuaternion(this.tempQuat);
        const relativeRot = worldRot.premultiply(this.tempQuat.invert());

        return { position: relativePos, rotation: relativeRot };
    }

    private calculateRelativeTransformFromObject(object: Object3D): { position: Vector3; rotation: Quaternion } | null {
        if (!this.sandboxRoot) return null;

        object.updateWorldMatrix(true, false);
        const worldPos = new Vector3();
        const worldRot = new Quaternion();
        object.getWorldPosition(worldPos);
        object.getWorldQuaternion(worldRot);

        this.sandboxRoot.updateWorldMatrix(true, false);
        this.sandboxInverseMatrix.copy(this.sandboxRoot.matrixWorld).invert();

        const relativePos = worldPos.applyMatrix4(this.sandboxInverseMatrix);
        this.sandboxRoot.getWorldQuaternion(this.tempQuat);
        const relativeRot = worldRot.premultiply(this.tempQuat.invert());

        return { position: relativePos, rotation: relativeRot };
    }

    private applyRelativeTransform(
        object: Object3D,
        relativePos: { x: number; y: number; z: number },
        relativeRot: { x: number; y: number; z: number; w: number }
    ): void {
        if (!this.sandboxRoot) return;

        this.sandboxRoot.updateWorldMatrix(true, false);
        this.tempVec3.set(relativePos.x, relativePos.y, relativePos.z);

        if (object.parent === this.sandboxRoot) {
            // Local coords
            object.position.lerp(this.tempVec3, this.interpolationFactor);
            this.tempQuat.set(relativeRot.x, relativeRot.y, relativeRot.z, relativeRot.w);
            object.quaternion.slerp(this.tempQuat, this.interpolationFactor);
        } else {
            // World coords
            const worldPos = this.tempVec3.applyMatrix4(this.sandboxRoot.matrixWorld);
            this.sandboxRoot.getWorldQuaternion(this.tempQuat);
            this.tempQuat2.set(relativeRot.x, relativeRot.y, relativeRot.z, relativeRot.w);
            const worldRot = this.tempQuat2.premultiply(this.tempQuat);

            object.position.lerp(worldPos, this.interpolationFactor);
            object.quaternion.slerp(worldRot, this.interpolationFactor);
        }

        object.updateMatrix();
    }

    // ========================================================================
    // Utility
    // ========================================================================

    private canSync(): boolean {
        if (!this.context.connection.isInRoom) return false;
        if (!this.sandboxRoot) return false;
        if (!WebARSessionRoot.hasPlaced) return false;
        return true;
    }

    private getLocalId(): string {
        return this.context.connection.connectionId ?? "";
    }

    private getImageId(image: any): string {
        const model = image.model;
        const index = this.imageTracking?.trackedImages.indexOf(model) ?? -1;
        return `tracked_image_${index}`;
    }

    private getAssetIndex(image: any): number {
        const model = image.model;
        return this.imageTracking?.trackedImages.indexOf(model) ?? -1;
    }
}