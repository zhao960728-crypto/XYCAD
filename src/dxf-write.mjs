import { Buffer } from 'node:buffer';

export function writeVectorDxf({ entities, units = 4, hiddenDash }) {
  const values = [];
  const emit = (...pairs) => values.push(...pairs);
  function section(name, write) {
    emit(0, 'SECTION', 2, name);
    write();
    emit(0, 'ENDSEC');
  }
  function table(name, handle, entries, write) {
    emit(0, 'TABLE', 2, name, 5, handle, 330, '0', 100, 'AcDbSymbolTable', 70, entries);
    write();
    emit(0, 'ENDTAB');
  }
  const spaces = [['10', '*Model_Space'], ['11', '*Paper_Space']];
  const layers = ['0', ...new Set(entities.map(entity => entity.layer))];
  const hex = value => value.toString(16).toUpperCase();
  let nextHandle=0x100+layers.length;
  const handle=()=>hex(nextHandle++);
  const dimensions=entities.filter(e=>e.type==='DIMENSION').map((entity,i)=>({entity,name:'*D'+(i+1),record:handle()}));
  const dimensionByEntity=new Map(dimensions.map(d=>[d.entity,d]));
  const dimensionHeight=dimensions[0]?.entity.height??2.5;
  function writeEntity(entity,owner='10') {
      const { type, layer, a } = entity;
      emit(0, type, 5, handle(), 330, owner, 100, 'AcDbEntity', 8, layer);
      if (entity.color !== undefined) emit(420, entity.color);
      const xyz = (code, [x,y]) => emit(code,x,code+10,y,code+20,0);
      switch (type) {
        case 'LINE':
          emit(100, 'AcDbLine');
          xyz(10, a);
          xyz(11, entity.b);
          break;
        case 'CIRCLE':
        case 'ARC':
          emit(100, 'AcDbCircle');
          xyz(10, a);
          emit(40, entity.radius);
          if (type === 'ARC') emit(100, 'AcDbArc', 50, entity.angles[0], 51, entity.angles[1]);
          break;
        case 'LWPOLYLINE':
          emit(100, 'AcDbPolyline', 90, entity.vertices.length, 70, (entity.closed ? 1 : 0) | (entity.patternContinuous ? 128 : 0));
          for (const [x, y] of entity.vertices) emit(10, x, 20, y);
          break;
        case 'SOLID':
          emit(100, 'AcDbTrace');
          for (const [j, point] of entity.vertices.entries()) xyz(10 + j, point);
          xyz(13, entity.vertices[2]);
          break;
        case 'TEXT':
          emit(100, 'AcDbText');
          xyz(10, a);
          emit(40, entity.height, 1, entity.value, 50, entity.angle, 41, entity.width, 7, 'Standard', 100, 'AcDbText');
          break;
        case 'DIMENSION': {
          const d=dimensionByEntity.get(entity),diameter=entity.kind==='diameter';
          emit(100,'AcDbDimension',280,0,2,d.name);xyz(10,entity.base);xyz(11,entity.textPoint);
          emit(70,32+128+(diameter?3:0),71,5,1,'<>',3,'XYCAD_DIM',42,entity.measurement);
          if(diameter){emit(100,'AcDbDiametricDimension');xyz(15,entity.b);emit(40,entity.leaderLength??0);}
          else{emit(100,'AcDbAlignedDimension');xyz(13,entity.a);xyz(14,entity.b);emit(50,entity.angle,100,'AcDbRotatedDimension');}
          break;
        }
        default:throw Error('含无法写入 DXF 的图元。');
}
  }
  section('HEADER', () => {
    emit(9, '$ACADVER', 1, 'AC1032', 9, '$HANDSEED', 5, '7FFFFFFF',
      9, '$INSUNITS', 70, units, 9, '$PSTYLEMODE', 290, 1,
      ...(dimensions.length?[9,'$DIMSTYLE',2,'XYCAD_DIM',9,'$DIMASSOC',280,1]:[]));
  });
  section('TABLES', () => {
    table('VPORT', '9', 0, () => {});
    table('LTYPE', '2', hiddenDash ? 4 : 3, () => {
      for (const [handle, name] of [['3', 'Continuous'], ['E', 'ByLayer'], ['F', 'ByBlock']]) {
        emit(0, 'LTYPE', 5, handle, 330, '2', 100, 'AcDbSymbolTableRecord', 100, 'AcDbLinetypeTableRecord',
          2, name, 70, 0, 3, name === 'Continuous' ? 'Solid line' : '', 72, 65, 73, 0, 40, 0);
      }
      if (hiddenDash) emit(0, 'LTYPE', 5, '13', 330, '2', 100, 'AcDbSymbolTableRecord', 100, 'AcDbLinetypeTableRecord',
        2, 'HIDDEN', 70, 0, 3, 'Hidden edges', 72, 65, 73, 2, 40, hiddenDash * 1.5,
        49, hiddenDash, 74, 0, 49, -hiddenDash / 2, 74, 0);
    });
    table('LAYER', '4', layers.length, () => {
      for (const [i, name] of layers.entries()) {
        emit(0, 'LAYER', 5, hex(0x40 + i), 330, '4', 100, 'AcDbSymbolTableRecord', 100, 'AcDbLayerTableRecord',
          2, name, 70, 0, 62, ({TEXT:3,KEY_INFO:2,DIM:4}[name]??7), 6, hiddenDash && name.endsWith('-HIDDEN') ? 'HIDDEN' : 'Continuous', 370, -3, 390, '38');
      }
    });
    table('STYLE', 'A', 1, () => {
      emit(0, 'STYLE', 5, 'B', 330, 'A', 100, 'AcDbSymbolTableRecord', 100, 'AcDbTextStyleTableRecord',
        2, 'Standard', 70, 0, 40, 0, 41, 1, 50, 0, 71, 0, 42, 2.5, 3, 'simsun.ttc', 4, '');
    });
    table('VIEW', 'C', 0, () => {});
    table('UCS', 'D', 0, () => {});
    table('APPID', '7', 1, () => {
      emit(0, 'APPID', 5, '8', 330, '7', 100, 'AcDbSymbolTableRecord', 100, 'AcDbRegAppTableRecord',
        2, 'ACAD', 70, 0);
    });
    table('DIMSTYLE', '12', 1, () => {
      emit(100,'AcDbDimStyleTable',71,1);
      emit(0,'DIMSTYLE',105,'15',330,'12',100,'AcDbSymbolTableRecord',100,'AcDbDimStyleTableRecord',2,'XYCAD_DIM',70,0,
        40,1,41,dimensionHeight*.65,42,dimensionHeight*.2,44,dimensionHeight*.4,
        140,dimensionHeight,147,dimensionHeight*.3,77,1,78,8,271,3,278,46,340,'B');
    });
    table('BLOCK_RECORD', '6', spaces.length+dimensions.length, () => {
      for (const [handle, name] of spaces) emit(0, 'BLOCK_RECORD', 5, handle, 330, '6',
        100, 'AcDbSymbolTableRecord', 100, 'AcDbBlockTableRecord', 2, name, 70, 0, 280, 1, 281, 0);
      for(const d of dimensions)emit(0,'BLOCK_RECORD',5,d.record,330,'6',100,'AcDbSymbolTableRecord',100,'AcDbBlockTableRecord',2,d.name,70,0,280,1,281,0);
    });
  });
  section('BLOCKS', () => {
    for (const [i, [owner, name]] of spaces.entries()) {
      emit(0, 'BLOCK', 5, (32 + 2 * i).toString(16), 330, owner, 100, 'AcDbEntity', 8, '0',
        100, 'AcDbBlockBegin', 2, name, 70, 0, 10, 0, 20, 0, 30, 0, 3, name, 1, '');
      emit(0, 'ENDBLK', 5, (33 + 2 * i).toString(16), 330, owner, 100, 'AcDbEntity', 8, '0', 100, 'AcDbBlockEnd');
    }
    for(const d of dimensions){
      emit(0,'BLOCK',5,handle(),330,d.record,100,'AcDbEntity',8,'DIM',100,'AcDbBlockBegin',2,d.name,70,1,10,0,20,0,30,0,3,d.name,1,'');
      for(const entity of d.entity.graphics)writeEntity(entity,d.record);
      emit(0,'ENDBLK',5,handle(),330,d.record,100,'AcDbEntity',8,'DIM',100,'AcDbBlockEnd');
    }
  });
  section('ENTITIES', () => { for(const entity of entities)writeEntity(entity); });
  section('OBJECTS', () => {
    emit(0, 'DICTIONARY', 5, '31', 330, '0', 100, 'AcDbDictionary', 281, 1,
      3, 'ACAD_PLOTSTYLENAME', 350, '37');
    emit(0, 'ACDBDICTIONARYWDFLT', 5, '37', 330, '31', 100, 'AcDbDictionary', 281, 1,
      3, 'Normal', 350, '38', 100, 'AcDbDictionaryWithDefault', 340, '38');
    emit(0, 'ACDBPLACEHOLDER', 5, '38', 330, '37');
  });
  emit(0, 'EOF', '');
  return Buffer.from(values.join('\r\n'));
}
