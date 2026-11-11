import { describe, it, expect } from 'vitest'
import { transfer, wagonIssue, wagonTracks, waybillWagons, type PlacementContainer } from './waybillPlacement'
const a: PlacementContainer = { rowId:'a',containerId:'c1',number:'C1',type:'STANDARD_40',grossWeight:23000,waybillId:'bill1',waybillNumber:'101',wagonId:'w1',selected:true }
const b: PlacementContainer = { ...a,rowId:'b',containerId:'c2',number:'C2',waybillId:'bill2',waybillNumber:'102',wagonId:'w2' }
describe('railway placement',()=>{
 it('shows two invoices on one physical wagon as separate cards and counts their shared load',()=>{
  const wagon={id:'w1',number:'123',feet:80,capacity:null},second={...b,wagonId:'w1'}
  const groups=waybillWagons({waybills:[],wagons:[wagon],containers:[a,second],version:'v'}, {})
  expect(groups).toHaveLength(2);expect(groups.map(g=>g.waybillId)).toEqual(['bill1','bill2'])
  expect(groups.map(g=>g.rows.map(c=>c.rowId))).toEqual([['a'],['b']])
  expect(groups.every(g=>g.physicalRows.length===2&&g.occupiedFeet===40)).toBe(true)
  expect(wagonTracks(wagon,groups[0].rows,groups[0].occupiedFeet)).toEqual({freeFeet:0,columns:'minmax(0,40fr) minmax(0,40fr)'})
 })
 it('regroups moved KTK by its original invoice and target wagon without duplicating rows',()=>{
  const wagons=[{id:'w1',number:'1',feet:80,capacity:null},{id:'w2',number:'2',feet:80,capacity:null}]
  const groups=waybillWagons({waybills:[],wagons,containers:[a,b],version:'v'},{a:{wagonId:'w2',waybillId:'bill1'}})
  expect(groups.filter(g=>g.rows.length).map(g=>[g.waybillId,g.wagon.id]).sort()).toEqual([['bill1','w2'],['bill2','w2']])
  expect(groups.flatMap(g=>g.rows).map(c=>c.rowId).sort()).toEqual(['a','b']);expect(groups[0].rows).toEqual([])
 })
 it('counts only selected invoices across cards of a shared wagon',()=>{
  const wagon={id:'w1',number:'1',feet:80,capacity:null}
  const groups=waybillWagons({waybills:[],wagons:[wagon],containers:[a,{...b,wagonId:'w1'},{...b,rowId:'c',waybillId:'bill3',wagonId:'w1',selected:false}],version:'v'}, {})
  expect(groups).toHaveLength(2);expect(groups.every(g=>wagonIssue(wagon,g.physicalRows)===null)).toBe(true);expect(groups.every(g=>g.physicalRows.length===2&&g.occupiedFeet===40)).toBe(true)
 })
 it('does not fill free space with an unselected invoice',()=>{
  const wagon={id:'w1',number:'123',feet:80,capacity:null}
  const groups=waybillWagons({waybills:[{id:'bill1',number:'101'}],wagons:[wagon],containers:[a,{...b,wagonId:'w1',selected:false}],version:'v'}, {})
  expect(groups).toHaveLength(1);expect(groups[0].occupiedFeet).toBe(0)
  expect(wagonTracks(wagon,groups[0].rows,groups[0].occupiedFeet).freeFeet).toBe(40)
 })
 it('reserves half of an 80ft platform for a single 40ft container',()=>expect(wagonTracks({id:'w',number:'1',feet:80,capacity:null},[a])).toEqual({freeFeet:40,columns:'minmax(0,40fr) minmax(0,40fr)'}))
 it('uses proportional tracks for mixed lengths and preserves the free quarter',()=>expect(wagonTracks({id:'w',number:'1',feet:80,capacity:null},[a,{...b,type:'STANDARD_20'}])).toEqual({freeFeet:20,columns:'minmax(0,40fr) minmax(0,20fr) minmax(0,20fr)'}))
 it('shows every container of an overloaded source without a negative free area',()=>{const tracks=wagonTracks({id:'w',number:'1',feet:80,capacity:null},Array.from({length:6},()=>({...a,type:'STANDARD_20'})));expect(tracks.freeFeet).toBe(0);expect(tracks.columns.split(' ')).toHaveLength(6)})
 it('moves a container without moving its document identity',()=>{expect(transfer({},[a,b],'a','w2')).toEqual({a:{wagonId:'w2',waybillId:'bill1'}});expect(a.waybillNumber).toBe('101')})
 it('swaps occupied positions using current draft positions',()=>expect(transfer({a:{wagonId:'w3',waybillId:'bill1'}},[a,b],'a','w2','b')).toEqual({a:{wagonId:'w2',waybillId:'bill1'},b:{wagonId:'w3',waybillId:'bill2'}}))
 it('cannot move or swap an unselected document',()=>{expect(transfer({},[{...a,selected:false},b],'a','w2')).toEqual({});expect(transfer({},[a,{...b,selected:false}],'a','w2','b')).toEqual({})})
 it('keeps each waybill when moving onto another waybill wagon and when swapping back',()=>{
  const moved=transfer({},[a,b],'a','w2')
  expect(moved.a).toEqual({wagonId:'w2',waybillId:'bill1'})
  const groups=waybillWagons({waybills:[{id:'bill1',number:'101'},{id:'bill2',number:'102'}],wagons:[{id:'w2',number:'2',feet:80,capacity:null}],containers:[a,b],version:'v'},moved)
  expect(groups.map(g=>g.waybillNumber)).toEqual(['101','102']);expect(groups.map(g=>g.rows.length)).toEqual([1,1])
  const swapped=transfer({},[a,b],'a','w2','b')
  const restored=transfer(swapped,[a,b],'a','w1','b')
  expect(restored).toEqual({a:{wagonId:'w1',waybillId:'bill1'},b:{wagonId:'w2',waybillId:'bill2'}})
 })
 it('does not reassign waybills between cards of the same physical wagon',()=>{
  const rows=[a,{...b,wagonId:'w1'}]
  expect(transfer({},rows,'a','w1')).toEqual({})
  expect(transfer({},rows,'a','w1','b')).toEqual({})
 })
 it('ignores length of unselected containers',()=>{expect(wagonIssue({id:'w',number:'123',feet:80,capacity:70000},[a,b,{...a,rowId:'c',selected:false}])).toBeNull()})
 it('allows four 20ft containers regardless of mass or lifting capacity',()=>{const rows=Array.from({length:4},(_,i)=>({...a,rowId:String(i),type:'STANDARD_20',grossWeight:99000}));expect(wagonIssue({id:'w',number:'123',feet:80,capacity:1},rows)).toBeNull();expect(wagonIssue({id:'w',number:'123',feet:80,capacity:null},rows)).toBeNull();expect(wagonIssue({id:'w',number:'123',feet:80,capacity:null},[...rows,rows[0]])).toContain('длина')})
 it('accepts mixed lengths and rejects lengths above platform capacity',()=>{const twenty={...a,type:'STANDARD_20'};expect(wagonIssue({id:'w',number:'123',feet:80,capacity:null},[a,twenty,twenty])).toBeNull();expect(wagonIssue({id:'w',number:'123',feet:60,capacity:null},[a,b])).toContain('длина')})
 it('rejects unknown platform or container length',()=>{expect(wagonIssue({id:'w',number:'123',feet:null,capacity:null},[a])).toContain('длина');expect(wagonIssue({id:'w',number:'123',feet:80,capacity:null},[{...a,type:'OTHER'}])).toContain('футовость')})
})
