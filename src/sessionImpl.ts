/// <reference path="../typings/async.d.ts" />

import async = require("async");
import Callback = require("./core/callback");
import ChangeTracking = require("./mapping/changeTracking");
import Constructor = require("./core/constructor");
import LockMode = require("./lockMode");
import Identifier = require("./id/identifier");
import IteratorCallback = require("./core/iteratorCallback");
import Map = require("./core/map");
import PropertyFlags = require("./mapping/propertyFlags");
import ResultCallback = require("./core/resultCallback");
import InternalSession = require("./internalSession");
import InternalSessionFactory = require("./internalSessionFactory");
import TaskQueue = require("./taskQueue");
import Persister = require("./persister");
import Batch = require("./batch");
import Reference = require("./reference");
import Table = require("./core/table");
import EntityMapping = require("./mapping/entityMapping");

enum ObjectState {

    /**
     * Managed entities have a persistent identity and are associated with a session.
     */
    Managed,

    /**
     * Detached entities have a persistent identity and are not currently associated with a session.
     */
    Detached,

    /**
     * Removed entities have a persistent identity, are associated with a session, and are scheduled for deletion
     * from the mongodb. Once the entity is deleted from the mongodb, the entity is no longer managed and is
     * considered a new entity.
     */
    Removed
}

enum ObjectFlags {

    None = 0,
    ReadOnly = 0x00000001
}

enum Action {

    Save = 0x00000001,
    Remove = 0x00000002,
    Detach = 0x00000004,
    Flush = 0x00000008,
    Clear = 0x00000010,
    Find = 0x00000020,
    Refresh = 0x00000040,
    Merge = 0x00000080,
    Fetch = 0x00000100,
    All = Save | Remove | Detach | Flush | Clear | Find | Refresh | Merge | Fetch
}

enum ScheduledOperation {

    None = 0,
    Insert,
    Update,
    Delete,
    DirtyCheck
}

// TODO: option to use weak reference until object is removed or modified and attach event to unlink if garbage collected? https://github.com/TooTallNate/node-weak
interface ObjectLinks {

    state: ObjectState;
    scheduledOperation: ScheduledOperation;
    object: any;
    originalDocument?: any;
    persister: Persister;
}

// TODO: read-only query results. perhaps not needed if we can use Object.observe in Node v12 to be notified of which objects have changed.
// TODO: raise events on UnitOfWork
class SessionImpl implements InternalSession {

    private _persisterByMapping: Table<Persister> = [];
    private _objectLinks: Map<ObjectLinks> = {};
    private _queue: TaskQueue;

    constructor(public factory: InternalSessionFactory) {

        // Using a delegate is faster than bind http://jsperf.com/bind-vs-function-delegate
        this._queue = new TaskQueue((action, args, callback) => this._execute(action, args, callback));
    }

    save(obj: any, callback?: Callback): void {

        this._queue.add(Action.Save, Action.All & ~Action.Save, obj, callback);
    }

    remove(obj: any, callback?: Callback): void {

        this._queue.add(Action.Remove, Action.All & ~Action.Remove, obj, callback);
    }

    refresh(obj: any, callback?: Callback): void {

        this._queue.add(Action.Refresh, Action.All & ~Action.Refresh, obj, callback);
    }

    detach(obj: any, callback?: Callback): void {

        this._queue.add(Action.Detach, Action.All & ~Action.Detach, obj, callback);
    }

    clear(callback?: Callback): void {

        this._queue.add(Action.Clear, Action.All, undefined, callback);
    }

    flush(callback?: Callback): void {

        this._queue.add(Action.Flush, Action.All, undefined, callback);
    }

    find<T>(ctr: Constructor<T>, id: any, callback: ResultCallback<T>): void {

        this._queue.add(Action.Find, Action.All & ~(Action.Find | Action.Fetch), [ctr, id], callback);
    }

    fetch<T>(obj: T, pathsOrCallback: any, callback?: ResultCallback<T>): void {

        var paths: string[];

        if(typeof pathsOrCallback === "function") {
            callback = pathsOrCallback;
        }
        else if(typeof pathsOrCallback === "string") {
            paths = [pathsOrCallback];
        }
        else {
            paths = pathsOrCallback;
        }

        this._queue.add(Action.Fetch, Action.All & ~(Action.Find | Action.Fetch), [obj, paths], callback);
    }

    /**
     * Gets the database identifier for an entity.
     * @param obj The entity.
     */
    getId(obj: any): any {

        return obj["_id"];
    }

    /**
     * Determines whether an entity is managed by this session.
     * @param entity The entity to check.
     */
    contains(obj: any): boolean {

        var id = obj["_id"];
        if(id) {
            var links = this._objectLinks[id.toString()];
            return links && links.state != ObjectState.Removed;
        }

        return false;
    }

    /**
     * Get an instance whose state may be fetched in the future.
     * @param ctr The constructor
     * @param id The id of the entity
     * @returns The entity instance or a reference to the entity instance.
     */
    getReference<T>(ctr: Constructor<T>, id: any): T {

        // If mapping is not found, the reference is still created and an error is returned when the client tries
        // to resolve the reference.
        var mapping = this.factory.getMappingForConstructor(ctr);
        if (mapping) {
            if(typeof id === "string") {
                id = mapping.identity.fromString(id);
            }
        }

        return this.getReferenceInternal(mapping, id);
    }

    getReferenceInternal(mapping: EntityMapping, id: Identifier): any {

        // TODO: should we cache references so all references with the same id share the same object?
        return this.getObject(id) || new Reference(this, mapping, id);
    }

    /**
     * Gets a managed object by the specified id. If the object is found but scheduled for delete then null is
     * returned. If the object is not found then undefined is returned; otherwise, the object is returned.
     * @param id The object identifier.
     */
    getObject(id: Identifier): any {

        var links = this._objectLinks[id.toString()];
        if (links) {
            return links.state == ObjectState.Removed ? null : links.object;
        }
    }

    registerManaged(persister: Persister, entity: any, document: any): void {

        // save the original document for dirty checking
        this._linkObject(entity, persister).originalDocument = document;
    }

    /**
     * Called by TaskQueue to execute an operation.
     * @param action The action to execute.
     * @param arg Contains arguments for the action.
     * @param callback Called when method completes.
     */
    private _execute(action: Action, arg: any, callback: ResultCallback<any>): void {

        switch(action) {
            case Action.Save:
                this._save(arg, callback);
                break;
            case Action.Remove:
                this._remove(arg, callback);
                break;
            case Action.Detach:
                this._detach(arg, callback);
                break;
            case Action.Clear:
                this._clear(callback);
                break;
            case Action.Flush:
                this._flush(callback);
                break;
            case Action.Find:
                this._find(arg[0], arg[1], callback);
                break;
            case Action.Fetch:
                this._fetch(arg[0], arg[1], callback);
                break;
        }
    }

    private _save(obj: any, callback: Callback): void {

        this._findReferencedEntities(obj, PropertyFlags.CascadeSave, (err, entities) => {
            if(err) return callback(err);
            this._saveEntities(entities, callback);
        });
    }

    private _saveEntities(entities: any[], callback: Callback): void {

        for(var i = 0, l = entities.length; i < l; i++) {
            var obj = entities[i];
            var links = this._getObjectLinks(obj);
            if (!links) {
                var persister = this._getPersisterForObject(obj);
                if (!persister) {
                    callback(new Error("Object type is not mapped as an entity."));
                    return;
                }

                // we haven't seen this object before
                obj["_id"] = persister.identity.generate();
                this._linkObject(obj, persister, ScheduledOperation.Insert);
            }
            else {
                switch (links.state) {
                    case ObjectState.Managed:
                        if (links.persister.changeTracking == ChangeTracking.DeferredExplicit && !links.scheduledOperation) {
                            links.scheduledOperation = ScheduledOperation.DirtyCheck;
                        }
                        break;
                    case ObjectState.Detached:
                        callback(new Error("Cannot save a detached object."));
                        return;
                    case ObjectState.Removed:
                        // Cancel delete operation and make managed.
                        links.scheduledOperation = ScheduledOperation.None;
                        links.state = ObjectState.Managed;
                        break;
                }
            }
        }

        callback();
    }

    private _remove(obj: any, callback: Callback): void {

        this._findReferencedEntities(obj, PropertyFlags.CascadeRemove | PropertyFlags.Dereference, (err, entities) => {
            if(err) return callback(err);
            this._removeEntities(entities, callback);
        });
    }

    private _removeEntities(entities: any[], callback: Callback): void {

        // remove in reverse order
        for(var i = entities.length - 1; i >= 0; i--) {
            var obj = entities[i];

            var links = this._getObjectLinks(obj);
            if (links) {
                switch (links.state) {
                    case ObjectState.Managed:
                        if (links.scheduledOperation == ScheduledOperation.Insert) {
                            // if the object has never been persisted then unlink the object and clear it's id
                            this._unlinkObject(links);
                        }
                        else {
                            // queue object for delete operation
                            links.scheduledOperation = ScheduledOperation.Delete;
                            links.state = ObjectState.Removed;
                            // object is unlinked after flush
                        }
                        break;
                    case ObjectState.Detached:
                        callback(new Error("Cannot remove a detached object."));
                        return;
                }
            }
        }

        callback();
    }

    private _detach(obj: any, callback: Callback): void {

        this._findReferencedEntities(obj, PropertyFlags.CascadeDetach, (err, entities) => {
            if(err) return callback(err);
            this._detachEntities(entities, callback);
        });
    }

    private _detachEntities(entities: any[], callback: Callback): void {

        for(var i = 0, l = entities.length; i < l; i++) {
            var links = this._getObjectLinks(entities[i]);
            if (links && links.state == ObjectState.Managed) {
                this._unlinkObject(links);
            }
        }

        callback();
    }

    private _refresh(obj: any, callback: Callback): void {

        this._findReferencedEntities(obj, PropertyFlags.CascadeRefresh, (err, entities) => {
            if(err) return callback(err);
            this._refreshEntities(entities, callback);
        });
    }

    private _refreshEntities(entities: any[], callback: Callback): void {

        async.each(entities, (entity: any, done: (err?: Error) => void) => {
            var links = this._getObjectLinks(entity);
            if (!links || links.state != ObjectState.Managed) {
                return done(new Error("Object is not managed."));
            }
            links.persister.refresh(links.object, (err, document) => {
                if(err) return done(err);
                links.originalDocument = document;
                done();
            });
        }, callback);
    }

    // TODO: if flush fails, mark session invalid and don't allow any further operations?
    // TODO: if operations fails (e.g. save, etc.) should session become invalid? Perhaps have two classes of errors, those that cause the session to become invalid and those that do not?
    private _flush(callback: Callback): void {

        // TODO: put requirement to order operations on the persister, not in the session
        // Get all list of all object links. A for-in loop is slow so build a list from the map since we are going
        // to have to iterate through the list several times.
        var list = this._getAllObjectLinks();

        var batch = new Batch();

        // Add operations to batch group by operation type. MongoDB bulk operations need to be ordered by operation
        // type or they are not executed as bulk operations.

        // do a dirty check if the object is scheduled for dirty check or the change tracking is deferred implicit and the object is not scheduled for anything else
        for(var i = 0, l = list.length; i < l; i++) {
            var links = list[i];
            // TODO: ignore read-only objects
            if (links.scheduledOperation == ScheduledOperation.DirtyCheck || (links.persister.changeTracking == ChangeTracking.DeferredImplicit && !links.scheduledOperation)) {
                var result = links.persister.dirtyCheck(batch, links.object, links.originalDocument);
                if(result.error) {
                    return callback(result.error);
                }
                else {
                    links.originalDocument = result.value;
                }
            }
        }

        // Add all inserts
        for (var i = 0, l = list.length; i < l; i++) {
            var links = list[i];
            if (links.scheduledOperation == ScheduledOperation.Insert) {
                var result = links.persister.insert(batch, links.object);
                if(result.error) {
                    return callback(result.error);
                }
                else {
                    links.originalDocument = result.value;
                }
            }
        }

        // Add all deletes
        for (var i = 0, l = list.length; i < l; i++) {
            var links = list[i];
            if (links.scheduledOperation == ScheduledOperation.Delete) {
                links.persister.remove(batch, links.object);
            }
        }

        // TODO: what to do if we get an error during execute? Should we make the session invalid? yes.
        batch.execute(err => {
            if(err) return callback(err);

            for (var i = 0, l = list.length; i < l; i++) {
                var links = list[i];
                if(links.scheduledOperation == ScheduledOperation.Delete) {
                    // after a successful delete operation unlink the object
                    this._unlinkObject(links);
                }
                // clear any scheduled operations
                links.scheduledOperation = ScheduledOperation.None;
            }
            callback();
        });
    }

    private  _fetch(obj: any, paths: string[], callback: ResultCallback<any>): void {

        // TODO: when a reference is resolved do we update the referenced object? __proto__ issue
        if(Reference.isReference(obj)) {
            (<Reference>obj).fetch((err, entity) => {
                if(err) return callback(err);
                this._fetchPaths(entity, paths, callback);
            });
        }
        else {
            this._fetchPaths(obj, paths, callback);
        }
    }

    private _fetchPaths(obj: any, paths: string[], callback: ResultCallback<any>): void {

        if(!paths || paths.length == 0) {
            process.nextTick(() => callback(null, obj));
        }


    }

    /**
     * Returns all linked objected as an array.
     */
    private _getAllObjectLinks(): ObjectLinks[] {

        var ret: ObjectLinks[] = [];

        var objectLinks = this._objectLinks;
        for (var id in objectLinks) {
            if (objectLinks.hasOwnProperty(id)) {
                ret.push(objectLinks[id]);
            }
        }

        return ret;
    }

    /**
     * Detaches all managed objects.
     * @param callback Callback to execute after operation completes.
     */
    private _clear(callback: Callback): void {

        this._objectLinks = {};
        process.nextTick(callback);
    }

    private _find(ctr: Constructor<any>, id: any, callback: ResultCallback<any>): void {

        var persister = this._getPersisterForConstructor(ctr);
        if (!persister) {
            return process.nextTick(() => callback(new Error("Object type is not mapped as an entity.")));
        }

        if(typeof id === "string") {
            id = persister.identity.fromString(id);
        }

        persister.findOneById(id, callback);
    }

    private _getObjectLinks(obj: any): ObjectLinks {

        var id = obj["_id"];
        if (id) {
            var links = this._objectLinks[id.toString()];
            if (!links) {
                // If we have an id but no links then the object must be detached since we assume that we manage
                // the assignment of the identifier.
                var persister = this._getPersisterForObject(obj);
                if (!persister) return;

                links = this._linkObject(obj, persister);
                links.state = ObjectState.Detached;
            }
            return links;
        }
    }

    private _linkObject(obj: any, persister: Persister, operation = ScheduledOperation.None): ObjectLinks {

        var id = obj["_id"].toString();
        if(this._objectLinks[id]) {
            throw new Error("Session already contains a managed entity with identifier '" + id + "'.");
        }

        var links = {
            state: ObjectState.Managed,
            scheduledOperation: operation,
            object: obj,
            persister: persister
        }

        return this._objectLinks[id] = links;
    }

    private _unlinkObject(links: ObjectLinks): void {

        delete this._objectLinks[links.object["_id"].toString()];

        // if the object was never persisted or if it has been removed, then clear it's identifier as well
        if (links.scheduledOperation == ScheduledOperation.Insert || links.state == ObjectState.Removed) {
            delete links.object["_id"];
        }
    }

    private _findReferencedEntities(obj: any, flags: PropertyFlags, callback: ResultCallback<any[]>): void {

        var mapping = this.factory.getMappingForObject(obj);
        if (!mapping) {
            process.nextTick(() => callback(new Error("Object type is not mapped as an entity.")));
            return;
        }

        var entities: any[] = [],
            embedded: any[] = [];

        this._walk(mapping, obj, flags, entities, embedded, err => {
            if(err) return process.nextTick(() => callback(err));
            return process.nextTick(() => callback(null, entities));
        });
    }

    private _walk(mapping: EntityMapping, entity: any, flags: PropertyFlags,  entities: any[], embedded: any[], callback: Callback): void {

        var references: Reference[] = [];
        mapping.walk(entity, flags, entities, embedded, references);

        // TODO: load references in batches grouped by root mapping
        async.each(references, (reference: Reference, done: (err?: Error) => void) => {

            reference.fetch((err: Error, entity: any) => {
                if (err) return done(err);
                this._walk(reference.mapping, entity, flags, entities, embedded, done);
            });
        }, callback);
    }

    private _getPersisterForObject(obj: any): Persister {

        var mapping = this.factory.getMappingForObject(obj);
        if(mapping) {
            return this.getPersister(mapping);
        }
    }

    private _getPersisterForConstructor(ctr: Constructor<any>): Persister {

        var mapping = this.factory.getMappingForConstructor(ctr);
        if(mapping) {
            return this.getPersister(mapping);
        }
    }

    getPersister(mapping: EntityMapping): Persister {

        return this._persisterByMapping[mapping.id]
            || (this._persisterByMapping[mapping.id] = this.factory.createPersister(this, mapping));
    }

}

export = SessionImpl;