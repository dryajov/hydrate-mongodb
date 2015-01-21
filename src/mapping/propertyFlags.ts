const enum PropertyFlags {
    None = 0,
    Ignored = 0x00000001,
    CascadeSave = 0x00000002,
    CascadeRemove = 0x00000004,
    CascadeDetach = 0x00000008,
    CascadeRefresh = 0x00000010,
    CascadeMerge = 0x00000020,
    CascadeAll = CascadeSave | CascadeRemove | CascadeDetach | CascadeRefresh | CascadeMerge,
    InverseSide = 0x00000040,
    Nullable = 0x00000080,
    OrphanRemoval = 0x00000100,
    Dereference = 0x00000200
}

export = PropertyFlags;

