// Narrow integer kernel for the deliberate f32 hash-rounding in PolkaCellHash.
// Positive normal inputs only; this is not a general floating-point interpreter.
export const polkaHashWGSL=/*wgsl*/`
fn rn_u32_bits(n:u32)->u32 {
 if(n==0u){return 0u;}
 var exponent=31u-countLeadingZeros(n);var mantissa:u32;
 if(exponent<=23u){mantissa=n<<(23u-exponent);}
 else{
  let shift=exponent-23u;mantissa=n>>shift;let remainder=n&((1u<<shift)-1u);let half=1u<<(shift-1u);
  if(remainder>half||(remainder==half&&(mantissa&1u)!=0u)){mantissa++;}
  if(mantissa==0x1000000u){mantissa>>=1u;exponent++;}
 }
 return ((exponent+127u)<<23u)|(mantissa&0x7fffffu);
}
fn rn_positive_mul(a:u32,b:u32)->u32 {
 let ea=(a>>23u)&255u;let eb=(b>>23u)&255u;
 if((a&0x80000000u)!=0u||(b&0x80000000u)!=0u||ea==0u||eb==0u||ea==255u||eb==255u){uncertain|=128u;return 0u;}
 let ma=(a&0x7fffffu)|0x800000u;let mb=(b&0x7fffffu)|0x800000u;
 let a0=ma&65535u;let a1=ma>>16u;let b0=mb&65535u;let b1=mb>>16u;
 let low=a0*b0;let middle=a1*b0+a0*b1+(low>>16u);
 let lo=(low&65535u)|(middle<<16u);let hi=a1*b1+(middle>>16u);
 let high_bit=(hi&0x8000u)!=0u;let shift=select(23u,24u,high_bit);
 var exponent=i32(ea)+i32(eb)-127+select(0,1,high_bit);
 var mantissa=(hi<<(32u-shift))|(lo>>shift);let remainder=lo&((1u<<shift)-1u);let half=1u<<(shift-1u);
 if(remainder>half||(remainder==half&&(mantissa&1u)!=0u)){mantissa++;}
 if(mantissa==0x1000000u){mantissa>>=1u;exponent++;}
 if(exponent<=0||exponent>=255){uncertain|=128u;return 0u;}
 return (u32(exponent)<<23u)|(mantissa&0x7fffffu);
}
fn polka_hash(a:u32,b:u32)->vec4u {
 if(a<25u||a>97u||b<160u||b>232u){uncertain|=128u;return vec4u(0u);}
 // Both squares are exact integers <2^24. Their product is <2^29; convert
 // directly with ties-to-even to reproduce the source float product.
 let base=rn_u32_bits((a*a)*(b*b));
 return vec4u(rn_positive_mul(base,0x3a84cd4eu),rn_positive_mul(base,0x3a89ce48u),rn_positive_mul(base,0x3acbdc41u),rn_positive_mul(base,0x3aa32fcfu));
}
`;
