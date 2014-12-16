/// <reference path="../typings/tsreflect.d.ts" />
/// <reference path="../typings/async.d.ts" />

import reflect = require("tsreflect");
import async = require("async");
import Callback = require("./callback");
import ChangeTracking = require("./mapping/changeTracking");
import CollectionTable = require("./driver/collectionTable");
import Constructor = require("./constructor");
import DocumentBuilder = require("./persister/documentBuilder");
import DocumentPersister = require("./persister/documentPersister");
import LockMode = require("./lockMode");
import Identifier = require("./id/identifier");
import IteratorCallback = require("./iteratorCallback");
import Map = require("./map");
import MappingRegistry = require("./mapping/mappingRegistry");
import ObjectBuilder = require("./persister/objectBuilder");
import PropertyFlags = require("./mapping/propertyFlags");
import ResultCallback = require("./resultCallback");
import Session = require("./session");
import SessionFactory = require("./sessionFactory");
import TypeMapping = require("./mapping/typeMapping");
import TypeMappingFlags = require("./mapping/typeMappingFlags");

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
     * Removed entities  have a persistent identity, are associated with a session, and are scheduled for deletion
     * from the mongodb. Once the entity is deleted from the mongodb, it is considered a new entity.
     */
    Removed
}

enum Operation {

    None = 0,
    Insert,
    Update,
    Delete,
    DirtyCheck
}

enum ObjectFlags {

    None = 0,
    ReadOnly = 0x00000001
}

interface Reference {
    mapping: TypeMapping;
    id: Identifier;
}

// TODO: option to use weak reference until object is removed or modified and attach event to unlink if garbage collected? https://github.com/TooTallNate/node-weak
interface ObjectLinks {

    state: ObjectState;
    scheduledOperation: Operation;
    object: any;
    originalDocument?: any;
    mapping: TypeMapping;
}

// TODO: read-only query results, read-only annotation for classes, raise events on UnitOfWork
class SessionImpl implements Session {

    private _collections: CollectionTable;
    private _mappingRegistry: MappingRegistry;
    private _objectLinks: Map<ObjectLinks> = {};
    private _objectLinksCount = 0;
    private _objectBuilder: ObjectBuilder;
    private _documentBuilder: DocumentBuilder;

    constructor(sessionFactory: SessionFactory) {

        this._collections = sessionFactory.collections;
        this._mappingRegistry = sessionFactory.mappingRegistry;
        this._objectBuilder = new ObjectBuilder(this._mappingRegistry);
        this._documentBuilder = new DocumentBuilder(this._mappingRegistry);
    }

    persist(obj: any, callback: Callback): void {

        /*
        this._persist(obj);
        callback();
        */

        this._forEachEntity(obj, (item: any, done: Callback) => {
            this._persist(item);
            done();
        }, callback);

    }

    _persist(obj: any): void {

        var links = this._getObjectLinks(obj);
        if (!links) {
            var mapping = this._mappingRegistry.getMappingForObject(obj);
            if (!mapping) {
                throw new Error("Object is not mapped as a document type.");
            }

            // we haven't seen this object before
            obj["_id"] = mapping.generateIdentifier();
            this._linkObject(obj, mapping, Operation.Insert);
            return;
        }

        switch (links.state) {
            case ObjectState.Managed:
                if (links.mapping.hasChangeTracking(ChangeTracking.DeferredExplicit) && !links.scheduledOperation) {
                    links.scheduledOperation = Operation.DirtyCheck;
                }
                // TODO: cascade persist to references flagged with cascadepersit even if current object is already managed
                break;
            case ObjectState.Detached:
                throw new Error("Cannot persist a detached object.");
                break;
            case ObjectState.Removed:
                // Cancel delete operation and make managed.
                links.scheduledOperation = Operation.None;
                links.state = ObjectState.Managed;
                break;
        }
    }

    remove(obj: any): void {

        // TODO: cascade remove to references flagged with cascaderemove event if current object is not managed
        var links = this._getObjectLinks(obj);
        if (!links) return;

        switch (links.state) {
            case ObjectState.Managed:
                // if the object has never been persisted then unlink the object and clear it's id
                if (links.scheduledOperation == Operation.Insert) {
                    this._unlinkObject(links);
                }
                else {
                    links.scheduledOperation = Operation.Delete;
                    links.state = ObjectState.Removed;
                    // TODO: after successful delete operation, unlink the object and clear the object's identifier
                }
                break;
            case ObjectState.Detached:
                throw new Error("Cannot remove a detached object.");
                break;
            case ObjectState.Removed:
                // nothing to do
                break;
        }
    }

    detach(obj: any): void {

        var links = this._getObjectLinks(obj);
        if (links && links.state == ObjectState.Managed) {
            this._unlinkObject(links);
        }
    }

    flush(callback: Callback): void {

        // Get all list of all object links. A for-in loop is slow so build a list from the map since we are going
        // to have to iterate through the list several times.
        var list = this._getAllObjectLinks();

        /*
         for(var i = 0, l = list.length; i < l; i++) {
         var links = list[i];
         // TODO: ignore read-only objects
         // do a dirty check if the object is scheduled for dirty check or the change tracking is deferred implicit and the object is not scheduled for anything else
         if(links.scheduledOperation == Operation.DirtyCheck || (links.mapping.rootType.changeTracking == ChangeTracking.DeferredImplicit && !links.scheduledOperation)) {

         var document = this._documentBuilder.buildDocument(links.object, links.mapping.type);
         }
         }
         */

        // MongoDB bulk operations need to be ordered by operation type or they are not executed
        // as bulk operations
        var persister = new DocumentPersister(this._collections, this._documentBuilder);

        // Add all inserts
        for (var i = 0, l = list.length; i < l; i++) {
            var links = list[i];
            if (links.scheduledOperation == Operation.Insert) {
                persister.addInsert(links.object, links.mapping);
            }
        }

        // Add all updates
        for (var i = 0, l = list.length; i < l; i++) {
            var links = list[i];
            if (links.scheduledOperation == Operation.Update) {
                persister.addUpdate(links.object, links.mapping);
            }
        }

        // Add all deletes
        for (var i = 0, l = list.length; i < l; i++) {
            var links = list[i];
            if (links.scheduledOperation == Operation.Delete) {
                persister.addDelete(links.object, links.mapping);
            }
        }

        persister.execute(callback);
    }

    find<T>(ctr: Constructor<T>, id: string, callback: ResultCallback<T>): void {

        // check to see if object is already loaded
        var links = this._getObjectLinksById(id);
        if (links) {
            return done(null, links.object);
        }

        var mapping = this._mappingRegistry.getMappingForConstructor(ctr);
        if (!mapping) {
            return done(new Error("Object is not mapped as a document type."));
        }

        this._findInCollection(mapping, mapping.root.identityGenerator.fromString(id), callback);

        function done(err: Error, result?: T) {
            process.nextTick(() => {
                callback(err, result);
            });
        }
    }

    private _find(mapping: TypeMapping, id: Identifier, callback: ResultCallback<any>): void {

        var links = this._getObjectLinksById(id);
        if (links) {
            process.nextTick(() => {
                callback(null, links.object);
            });
        }

        this._findInCollection(mapping, id, callback);
    }

    private _findInCollection(mapping: TypeMapping, id: Identifier, callback: ResultCallback<any>): void {

        this._collections[mapping.root.id].findOne({ _id: id }, (err, document) => {
            if (err) return callback(err);
            this._load(mapping, document, callback);
        });
    }

    // only call within async function
    private _load<T>(mapping: TypeMapping, document: any, callback: ResultCallback<T>): void {

        // if the document is null or undefined then return undefined
        if (!document) {
            // note that we are not ensuring the callback is called async because _load will only
            // be called within an async function
            return callback(null);
        }

        // check to see if object is already loaded
        var links = this._getObjectLinksById(document["_id"]);
        if (links) {
            return callback(null, links.object);
        }

        var obj = this._objectBuilder.buildObject(document, mapping.type);
        var links = this._linkObject(obj, mapping);
        // save the original document for dirty checking
        links.originalDocument = document;

        callback(null, obj);
    }

    private _getObjectLinksById(id: Identifier): ObjectLinks {

        return this._objectLinks[id.toString()];
    }

    private _getAllObjectLinks(): ObjectLinks[] {

        var ret: ObjectLinks[] = new Array(this._objectLinksCount),
            i = 0;

        var objectLinks = this._objectLinks;
        for (var id in objectLinks) {
            if (objectLinks.hasOwnProperty(id)) {
                ret[i++] = objectLinks[id];
            }
        }

        return ret;
    }

    private _getObjectLinks(obj: any): ObjectLinks {

        var id = obj["_id"];
        if (id) {
            var links = this._objectLinks[id.toString()];
            if (!links) {
                // If we have an id but no links then the object must be detached since we assume that we manage
                // the assignment of the identifier. Create object links.
                links = this._linkObject(obj);
                links.state = ObjectState.Detached;
            }
            return links;
        }
    }

    private _linkObject(obj: any, mapping?: TypeMapping, operation = Operation.None): ObjectLinks {

        if (!mapping) {
            var mapping = this._mappingRegistry.getMappingForObject(obj);
            if (!mapping) {
                throw new Error("Object is not mapped as a document type.");
            }
        }

        var links = {
            state: ObjectState.Managed,
            scheduledOperation: operation,
            object: obj,
            mapping: mapping
        }

        this._objectLinksCount++;
        return this._objectLinks[obj["_id"].toString()] = links;
    }

    private _unlinkObject(links: ObjectLinks): void {

        this._objectLinksCount--;
        delete this._objectLinks[links.object["_id"].toString()];

        // if the object was never persisted or if it has been removed, then clear it's identifier as well
        if (links.scheduledOperation == Operation.Insert || links.state == ObjectState.Removed) {
            this._clearIdentifier(links.object);
        }
    }

    private _clearIdentifier(obj: any): void {

        delete obj["_id"];
    }

    private _forEachEntity(obj: any, iterator: IteratorCallback<any>, callback: Callback): void {

        var mapping = this._mappingRegistry.getMappingForObject(obj);
        if (!mapping) {
            process.nextTick(() => callback(new Error("Object is not mapped as a document type.")));
        }

        var entities: any[] = [],
            embedded: any[] = [];
        this._walkEntity(obj, mapping, entities, embedded, err => {
            if(err) return callback(err);
            async.each(entities, iterator, callback);
        });
    }

    private _walkEntity(entity: any, mapping: TypeMapping, entities: any[], embedded: any[], callback: Callback): void {

        var references: Reference[] = [];
        this._walkValue(entity, mapping.type, entities, embedded, references);

        async.each(references, (reference: Reference, done: (err?: Error) => void) => {

            this._find(reference.mapping, reference.id, (err: Error, entity: any) => {
                if (err) return done(err);
                this._walkEntity(entity, reference.mapping, entities, embedded, callback);
            });
        }, err => callback(err));
    }

    private _walkValue(value: any, type: reflect.Type, entities: any[], embedded: any[], references: Reference[]): void {

        if (value === null || value === undefined) return;

        if (type.isTuple()) {
            if (Array.isArray(value)) {
                var elementTypes = type.getElementTypes();
                for (var i = 0, l = Math.min(value.length, elementTypes.length); i < l; i++) {
                    this._walkValue(value[i], elementTypes[i], entities, embedded, references);
                }
            }
            return;
        }

        if (type.isArray()) {
            if (Array.isArray(value)) {
                var elementType = type.getElementType();
                for (i = 0, l = value.length; i < l; i++) {
                    this._walkValue(value[i], elementType, entities, embedded, references);
                }
            }
            return;
        }

        if (type.isObjectType()) {
            // Object may be a subclass of the class whose type was passed, so retrieve mapping for the object. If it
            // does not exist, default to mapping for type.
            var mapping = this._mappingRegistry.getMappingForObject(value) || this._mappingRegistry.getMappingForType(type);
            if (!mapping) return;

            if (mapping.flags & TypeMappingFlags.DocumentType) {
                if (mapping.root.identityGenerator.isIdentifier(value)) {
                    var links = this._getObjectLinksById(value);
                    if (links) {
                        value = links.object;
                    }
                    else {
                        // store reference to resolve later
                        references.push({ mapping: mapping, id: value });
                        return;
                    }
                }
                if (entities.indexOf(value) !== -1) return;
                entities.push(value);
            }
            else {
                if (embedded.indexOf(value) !== -1) return;
                embedded.push(value);
            }

            var properties = mapping.properties;
            for (var i = 0, l = properties.length; i < l; i++) {
                var property = properties[i];
                if (!(property.flags & PropertyFlags.Ignored)) {
                    this._walkValue(property.symbol.getValue(value), property.symbol.getType(), entities, embedded, references);
                }
            }
        }
    }
}

export = SessionImpl;