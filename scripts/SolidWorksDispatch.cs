using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using DISPPARAMS = System.Runtime.InteropServices.ComTypes.DISPPARAMS;
using EXCEPINFO = System.Runtime.InteropServices.ComTypes.EXCEPINFO;
using IBindCtx = System.Runtime.InteropServices.ComTypes.IBindCtx;
using IEnumMoniker = System.Runtime.InteropServices.ComTypes.IEnumMoniker;
using IMoniker = System.Runtime.InteropServices.ComTypes.IMoniker;
using IRunningObjectTable = System.Runtime.InteropServices.ComTypes.IRunningObjectTable;

public static class SolidWorksDispatch
{
    [ComImport, Guid("00020400-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface Dispatch
    {
        void GetTypeInfoCount(out uint count);
        void GetTypeInfo(uint index, uint lcid, out IntPtr info);
        void GetIDsOfNames(ref Guid iid, [MarshalAs(UnmanagedType.LPArray, ArraySubType = UnmanagedType.LPWStr, SizeParamIndex = 2)] string[] names,
            uint count, uint lcid, out int id);
        [PreserveSig]
        int Invoke(int id, ref Guid iid, uint lcid, ushort flags, ref DISPPARAMS args,
            IntPtr result, ref EXCEPINFO error, out uint errorArgument);
    }

    public sealed class IntRef
    {
        public int Value;
    }

    public static IDisposable Watch(Process process)
    {
        // Bind the OS process handle while the newly created session is known to be live.
        var handle = process.Handle;
        return new Timer(_ =>
        {
            try
            {
                if (process.HasExited) return;
                process.CloseMainWindow();
                if (!process.WaitForExit(5000)) process.Kill();
            }
            catch (InvalidOperationException) { }
            catch (System.ComponentModel.Win32Exception) { }
        }, null, 45000, Timeout.Infinite);
    }

    [DllImport("oleaut32.dll")]
    private static extern int VariantClear(IntPtr variant);

    [DllImport("ole32.dll", PreserveSig = false)]
    private static extern void GetRunningObjectTable(int reserved, out IRunningObjectTable table);

    [DllImport("ole32.dll", PreserveSig = false)]
    private static extern void CreateBindCtx(int reserved, out IBindCtx context);

    public static object FindSession(int processId)
    {
        IRunningObjectTable table;
        GetRunningObjectTable(0, out table);
        IBindCtx context = null;
        IEnumMoniker entries = null;
        try
        {
            CreateBindCtx(0, out context);
            table.EnumRunning(out entries);
            var entry = new IMoniker[1];
            while (entries.Next(1, entry, IntPtr.Zero) == 0)
            {
                try
                {
                    string name;
                    entry[0].GetDisplayName(context, null, out name);
                    if (String.Equals(name, "SolidWorks_PID_" + processId, StringComparison.OrdinalIgnoreCase))
                    {
                        object session;
                        if (table.GetObject(entry[0], out session) == 0) return session;
                    }
                }
                catch (COMException) { }
                catch (UnauthorizedAccessException) { }
                finally { Marshal.ReleaseComObject(entry[0]); }
            }
            return null;
        }
        finally
        {
            if (entries != null) Marshal.ReleaseComObject(entries);
            if (context != null) Marshal.ReleaseComObject(context);
            Marshal.ReleaseComObject(table);
        }
    }

    public static object Call(object target, string member, params object[] values)
    {
        return Invoke(target, member, 1, values);
    }

    public static void Set(object target, string member, object value)
    {
        Invoke(target, member, 4, new[] { value });
    }

    public static object Get(object target, string member)
    {
        return Invoke(target, member, 2, new object[0]);
    }

    private static object Invoke(object target, string member, ushort flags, object[] values)
    {
        var dispatch = (Dispatch)target;
        var iid = Guid.Empty;
        int id;
        dispatch.GetIDsOfNames(ref iid, new[] { member }, 1, 0, out id);
        int size = IntPtr.Size == 8 ? 24 : 16;
        var args = new DISPPARAMS();
        args.cArgs = values.Length;
        args.rgvarg = Marshal.AllocCoTaskMem(size * values.Length);
        var result = Marshal.AllocCoTaskMem(size);
        var references = new IntPtr[values.Length];
        for (int i = 0; i < size * values.Length; i += 4) Marshal.WriteInt32(args.rgvarg, i, 0);
        for (int i = 0; i < size; i += 4) Marshal.WriteInt32(result, i, 0);
        try
        {
            if (flags == 4)
            {
                args.rgdispidNamedArgs = Marshal.AllocCoTaskMem(4);
                Marshal.WriteInt32(args.rgdispidNamedArgs, -3);
                args.cNamedArgs = 1;
            }
            for (int i = 0; i < values.Length; i++)
            {
                var slot = IntPtr.Add(args.rgvarg, size * (values.Length - i - 1));
                var byref = values[i] as IntRef;
                if (byref == null)
                {
                    Marshal.GetNativeVariantForObject(values[i], slot);
                }
                else
                {
                    references[i] = Marshal.AllocCoTaskMem(4);
                    Marshal.WriteInt32(references[i], byref.Value);
                    Marshal.WriteInt16(slot, 0x4003); // VT_BYREF | VT_I4
                    Marshal.WriteIntPtr(slot, 8, references[i]);
                }
            }
            var error = new EXCEPINFO();
            uint errorArgument;
            int code = dispatch.Invoke(id, ref iid, 0, flags, ref args, result, ref error, out errorArgument);
            if (code < 0) throw new COMException(member + " (argument " + errorArgument + "): " +
                (error.bstrDescription ?? Marshal.GetExceptionForHR(code).Message), code);
            for (int i = 0; i < values.Length; i++)
                if (references[i] != IntPtr.Zero) ((IntRef)values[i]).Value = Marshal.ReadInt32(references[i]);
            return Marshal.GetObjectForNativeVariant(result);
        }
        finally
        {
            VariantClear(result);
            Marshal.FreeCoTaskMem(result);
            Marshal.FreeCoTaskMem(args.rgdispidNamedArgs);
            for (int i = 0; i < values.Length; i++)
            {
                VariantClear(IntPtr.Add(args.rgvarg, size * i));
                Marshal.FreeCoTaskMem(references[i]);
            }
            Marshal.FreeCoTaskMem(args.rgvarg);
        }
    }
}
